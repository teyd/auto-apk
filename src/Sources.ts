/**
 * Where stock APKs come from. Each source downloads one exact version into a
 * directory and returns the file; `Verify` decides whether it can be used.
 *
 *   apkmirror  APKMirror's pages through FlareSolverr (Cloudflare blocks GitHub's
 *              runners otherwise), then the file directly with its cookies.
 *   apkpure    APKPure's app API: one request lists every version and its link.
 *   archive    An archive.org directory listing (j-hc's mirror).
 */
import { Config, Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { ResolvedSource } from "./Config.ts"
import { download } from "./GitHub.ts"
import { run, runOk } from "./Process.ts"

export class SourceError extends Data.TaggedError("SourceError")<{
  readonly source: ResolvedSource["name"]
  readonly reason: string
}> {
  override get message() {
    return `${this.source}: ${this.reason}`
  }
}

const failFor = (source: ResolvedSource["name"]) => (reason: string) =>
  new SourceError({ source, reason })

export interface Fetched {
  readonly source: ResolvedSource["name"]
  readonly file: string
  readonly from: string
}

export interface Want {
  readonly package: string
  readonly version: string
  readonly arch: string
}

/** Our own user agent for direct requests. No borrowed client identities. */
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")

/** Decode the HTML entities APKMirror uses in links. `&amp;` goes last, so it cannot create new entities. */
const decodeHtml = (s: string) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

// ---------------------------------------------------------------- FlareSolverr

interface SolvedPage {
  readonly status: number
  readonly html: string
  readonly url: string
  readonly userAgent: string
  readonly cookies: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly domain: string
  }>
}

const FlareResponse = Schema.Struct({
  status: Schema.String,
  message: Schema.optional(Schema.String),
  solution: Schema.optional(
    Schema.Struct({
      url: Schema.String,
      status: Schema.Finite,
      response: Schema.String,
      userAgent: Schema.String,
      cookies: Schema.Array(
        Schema.Struct({ name: Schema.String, value: Schema.String, domain: Schema.String }),
      ),
    }),
  ),
})

/**
 * A FlareSolverr client. With FLARESOLVERR_URL set it uses that instance; otherwise
 * it starts the pinned container on first use and removes it when the caller's
 * scope closes (the build), so apps that never reach APKMirror never start it.
 */
export const makeFlareSolverr = Effect.fn("makeFlareSolverr")(function* (image: string) {
  const external = yield* Config.option(Config.String("FLARESOLVERR_URL"))
  const http = yield* HttpClient.HttpClient
  const name = `auto-apk-flaresolverr-${process.pid}`
  const port = 18191

  const start = Effect.gen(function* () {
    if (Option.isSome(external)) return external.value
    yield* Effect.acquireRelease(
      runOk("docker", ["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:8191`, image]),
      () => runOk("docker", ["rm", "-f", name]).pipe(Effect.ignore),
    )
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 90; i++) {
      const up = yield* http.get(`${base}/`).pipe(
        Effect.map((r) => r.status === 200),
        Effect.orElseSucceed(() => false),
      )
      if (up) return base
      yield* Effect.sleep("1 second")
    }
    return yield* new SourceError({ source: "apkmirror", reason: "FlareSolverr did not start" })
  })
  const baseUrl = yield* Effect.cached(start)

  const get = (url: string) =>
    Effect.gen(function* () {
      const base = yield* baseUrl
      const res = yield* HttpClientRequest.post(`${base}/v1`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ cmd: "request.get", url, maxTimeout: 60000 }),
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(FlareResponse)),
        Effect.timeout("2 minutes"),
      )
      if (res.status !== "ok" || !res.solution) {
        return yield* new SourceError({
          source: "apkmirror",
          reason: `FlareSolverr: ${res.message ?? res.status} (${url})`,
        })
      }
      const s = res.solution
      return {
        status: s.status,
        html: s.response,
        url: s.url,
        userAgent: s.userAgent,
        cookies: s.cookies,
      } satisfies SolvedPage
    }).pipe(
      Effect.catchTag("SourceError", Effect.fail),
      Effect.mapError((e) =>
        e._tag === "SourceError"
          ? e
          : new SourceError({ source: "apkmirror", reason: `FlareSolverr: ${String(e)}` }),
      ),
    )
  return { get }
})

export type FlareSolverr = Effect.Success<ReturnType<typeof makeFlareSolverr>>

// ---------------------------------------------------------------- APKMirror

const APKMIRROR = "https://www.apkmirror.com"

/** The variant to download from a release page: APK before bundle, our arch or universal, nodpi first. */
export const pickVariant = (html: string, arch: string) => {
  const table = html.slice(html.indexOf("variants-table"))
  let best: { score: number; href: string; text: string } | undefined
  for (const row of table.split('<div class="table-row headerFont">').slice(1)) {
    const href = /href="([^"#]*-download\/)"/u.exec(row)?.[1]
    if (!href) continue
    const text = decodeHtml(row.replace(/<[^>]+>/gu, " "))
      .replace(/\s+/gu, " ")
      .trim()
    const archOk = text.includes(arch) || text.includes("universal") || text.includes("noarch")
    if (!archOk) continue
    const isBundle = / BUNDLE /u.test(` ${text} `)
    const score =
      (isBundle ? 0 : 4) + (text.includes("nodpi") ? 2 : 0) + (text.includes(arch) ? 1 : 0)
    if (!best || score > best.score)
      best = { score, href: decodeHtml(href), text: text.slice(0, 160) }
  }
  return best
}

export const apkmirror = Effect.fn("Sources.apkmirror")(function* (
  flare: FlareSolverr,
  appUrl: string,
  want: Want,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const fail = failFor("apkmirror")
  let pages = 0
  const page = (url: string) =>
    Effect.gen(function* () {
      if (pages++ > 0) yield* Effect.sleep("3 seconds") // stay well under APKMirror's rate limit
      return yield* flare.get(url)
    })

  const app = yield* page(appUrl)
  if (app.status !== 200) return yield* fail(`app page: HTTP ${app.status}`)
  let appPath = new URL(app.url).pathname
  if (!appPath.endsWith("/")) appPath += "/"

  // Release slugs, learned from this app's own release links (the page links other apps too).
  const prefixes = new Map<string, number>()
  for (const m of app.html.matchAll(/href="(\/apk\/[^"/]+\/[^"/]+\/)([^"/]+)-release\/"/gu)) {
    if (m[1] !== appPath || !m[2]) continue
    const prefix = /^(.*?-)(?=\d)/u.exec(m[2])?.[1]
    if (prefix) prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1)
  }
  if (prefixes.size === 0) return yield* fail(`app page: no release links under ${appPath}`)
  const versionSlugs = [
    ...new Set(
      [want.version, want.version.split(" ")[0] ?? "", want.version.split("-release")[0] ?? ""].map(
        slug,
      ),
    ),
  ]

  let release: SolvedPage | undefined
  let releaseUrl = ""
  const ordered = [...prefixes.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 3)
  search: for (const [prefix] of ordered) {
    for (const v of versionSlugs) {
      releaseUrl = `${APKMIRROR}${appPath}${prefix}${v}-release/`
      const p = yield* page(releaseUrl)
      if (p.status === 200 && p.html.includes("variants-table")) {
        release = p
        break search
      }
    }
  }
  if (!release) return yield* fail(`no release page for ${want.version}`)

  const variant = pickVariant(release.html, want.arch)
  if (!variant) return yield* fail(`no ${want.arch} or universal variant on ${releaseUrl}`)
  const variantPage = yield* page(`${APKMIRROR}${variant.href}`)
  const key = /href="([^"]*\/download\/\?key=[^"]*)"/u.exec(variantPage.html)?.[1]
  if (!key) return yield* fail(`variant page has no download button (${variant.text})`)
  const downloadPage = yield* page(`${APKMIRROR}${decodeHtml(key)}`)
  const file = /href="([^"]*download\.php\?[^"]*)"/u.exec(downloadPage.html)?.[1]
  if (!file) return yield* fail("download page has no file link")

  const cookie = downloadPage.cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./u, "")
      return domain === "apkmirror.com" || domain.endsWith(".apkmirror.com")
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ")
  const ext = / BUNDLE /u.test(` ${variant.text} `) ? "apkm" : "apk"
  const dest = path.join(dir, `${want.package}-${slug(want.version)}.${ext}`)
  // curl, not fetch: with the same headers and cookies Cloudflare answers Bun's fetch
  // with 403 and curl with the file. It tells the clients apart by their TLS handshake.
  const got = yield* run("curl", [
    "-sSL",
    "--retry",
    "2",
    "-o",
    dest,
    "-w",
    "%{http_code} %{content_type}",
    "-A",
    downloadPage.userAgent,
    "-H",
    `Cookie: ${cookie}`,
    "-e",
    `${APKMIRROR}${decodeHtml(key)}`,
    `${APKMIRROR}${decodeHtml(file)}`,
  ]).pipe(Effect.mapError((e) => fail(`curl: ${e.message}`)))
  const [status, type] = got.output.trim().split(" ")
  if (got.exitCode !== 0 || status !== "200" || (type ?? "").includes("text/html")) {
    yield* fs.remove(dest, { force: true })
    return yield* fail(`file: HTTP ${status} ${type ?? ""} (curl exit ${got.exitCode})`)
  }
  const fetched: Fetched = { source: "apkmirror", file: dest, from: releaseUrl }
  return fetched
})

// ---------------------------------------------------------------- APKPure

/** Every length-delimited value in a protobuf message, nested ones included. */
export const protobufStrings = (buf: Uint8Array): Array<string> => {
  const out: Array<string> = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const walk = (start: number, end: number, depth: number): boolean => {
    let i = start
    const varint = () => {
      let v = 0
      let shift = 0
      for (;;) {
        if (i >= end || shift > 35) throw new Error("bad varint")
        const b = buf[i++] ?? 0
        v += (b & 0x7f) * 2 ** shift
        if (b < 0x80) return v
        shift += 7
      }
    }
    try {
      while (i < end) {
        const tag = varint()
        const wire = tag & 7
        if (tag >> 3 === 0) return false
        if (wire === 0) varint()
        else if (wire === 1) i += 8
        else if (wire === 5) i += 4
        else if (wire === 2) {
          const len = varint()
          if (i + len > end) return false
          if (depth > 12 || !walk(i, i + len, depth + 1)) {
            try {
              out.push(decoder.decode(buf.subarray(i, i + len)))
            } catch {
              // binary, not a string
            }
          }
          i += len
        } else return false
      }
      return i === end
    } catch {
      return false
    }
  }
  walk(0, buf.length, 0)
  return out
}

/** APKPure download links carry `c=<category>|<group>|base64(vn=…&vc=…&t=…&s=…)`. */
export const parseApkPureLink = (link: string) => {
  const c = new URL(link).searchParams.get("c")
  const encoded = c?.split("|").at(-1)
  if (!encoded) return undefined
  const params = new URLSearchParams(
    Buffer.from(encoded.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString(),
  )
  const version = params.get("vn")
  if (!version) return undefined
  return { url: link, version, type: params.get("t") ?? "", size: Number(params.get("s") ?? "0") }
}

export const apkpure = Effect.fn("Sources.apkpure")(function* (want: Want, dir: string) {
  const path = yield* Path.Path
  const http = yield* HttpClient.HttpClient
  const fail = failFor("apkpure")
  const res = yield* http
    .get(
      `https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=${encodeURIComponent(want.package)}`,
      {
        headers: { "x-cv": "3172501", "x-sv": "29", "x-abis": want.arch, "x-gp": "1" },
      },
    )
    .pipe(Effect.mapError((e) => fail(e.message)))
  if (res.status !== 200) return yield* fail(`version list: HTTP ${res.status}`)
  const body = new Uint8Array(yield* res.arrayBuffer.pipe(Effect.mapError((e) => fail(e.message))))
  const links = protobufStrings(body)
    .filter((s) => s.startsWith("https://download.pureapk.com/b/"))
    .flatMap((s) => parseApkPureLink(s) ?? [])
  const match = links.find((l) => l.version === want.version)
  if (!match) {
    const listed = [...new Set(links.map((l) => l.version))].slice(0, 6).join(", ")
    return yield* fail(`version ${want.version} not listed (newest: ${listed || "none"})`)
  }
  const dest = path.join(
    dir,
    `${want.package}-${slug(want.version)}.${match.type === "xapk" ? "xapk" : "apk"}`,
  )
  yield* download(match.url, dest, { size: match.size || undefined }, { "User-Agent": UA }).pipe(
    Effect.mapError((e) => fail(e.message)),
  )
  const fetched: Fetched = { source: "apkpure", file: dest, from: "api.pureapk.com" }
  return fetched
})

// ---------------------------------------------------------------- archive.org

export const archive = Effect.fn("Sources.archive")(function* (
  dirUrl: string,
  want: Want,
  dir: string,
) {
  const path = yield* Path.Path
  const http = yield* HttpClient.HttpClient
  const fail = failFor("archive")
  const res = yield* http
    .get(`${dirUrl}/`, { headers: { "User-Agent": "auto-apk" } })
    .pipe(Effect.mapError((e) => fail(e.message)))
  if (res.status !== 200) return yield* fail(`listing: HTTP ${res.status}`)
  const listing = yield* res.text.pipe(Effect.mapError((e) => fail(e.message)))
  const files = [...listing.matchAll(/<a href="([^"?/]+\.(?:apk|apkm))"/gu)].flatMap((m) =>
    m[1] ? [decodeURIComponent(m[1])] : [],
  )
  const prefix = `${want.package}-${want.version}-`
  const name =
    files.find((f) => f.startsWith(`${prefix}${want.arch}.`)) ??
    files.find((f) => f.startsWith(`${prefix}all.`))
  if (!name)
    return yield* fail(`version ${want.version} not in the archive (${files.length} files)`)
  const dest = path.join(dir, name)
  yield* download(
    `${dirUrl}/${encodeURIComponent(name)}`,
    dest,
    {},
    { "User-Agent": "auto-apk" },
  ).pipe(Effect.mapError((e) => fail(e.message)))
  return { source: "archive", file: dest, from: `${dirUrl}/${name}` } satisfies Fetched
})
