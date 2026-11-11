/**
 * GitHub releases: find the release to use, and download assets with their hash checked.
 */
import { Config, Data, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export class GitHubError extends Data.TaggedError("GitHubError")<{ readonly message: string }> {}

export class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly url: string
  readonly reason: string
}> {
  override get message() {
    return `download ${this.url}: ${this.reason}`
  }
}

const Asset = Schema.Struct({
  name: Schema.String,
  size: Schema.Finite,
  browser_download_url: Schema.String,
  /** "sha256:<hex>", published by GitHub for assets uploaded since mid 2025. */
  digest: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Asset = typeof Asset.Type

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  assets: Schema.Array(Asset),
})
export type Release = typeof Release.Type

/** GITHUB_TOKEN, else GH_TOKEN, else none (anonymous: public reads only, low rate limit). */
const token = Config.all([
  Config.option(Config.String("GITHUB_TOKEN")),
  Config.option(Config.String("GH_TOKEN")),
]).pipe(Config.map(([a, b]) => Option.orElse(a, () => b)))

/** An HttpClient that talks to api.github.com, authenticated when a token is set. */
const apiClient = Effect.gen(function* () {
  const auth = yield* token
  const client = yield* HttpClient.HttpClient
  return client.pipe(
    HttpClient.mapRequest((req) =>
      req.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.setHeaders({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "auto-apk",
        }),
        Option.isSome(auth) ? HttpClientRequest.bearerToken(auth.value) : (r) => r,
      ),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ times: 3 }),
  )
})

const getJson = <S extends Schema.Top>(path: string, schema: S) =>
  Effect.gen(function* () {
    const client = yield* apiClient
    const res = yield* client.get(path)
    return yield* HttpClientResponse.schemaBodyJson(schema)(res)
  }).pipe(Effect.mapError((e) => new GitHubError({ message: `GET ${path}: ${e.message}` })))

/** Send a JSON request to the API and decode the reply. */
const sendJson = <S extends Schema.Top>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  schema: S,
) =>
  Effect.gen(function* () {
    const client = yield* apiClient
    const req = (
      method === "POST" ? HttpClientRequest.post(path) : HttpClientRequest.patch(path)
    ).pipe(HttpClientRequest.bodyJsonUnsafe(body))
    const res = yield* client.execute(req)
    return yield* HttpClientResponse.schemaBodyJson(schema)(res)
  }).pipe(Effect.mapError((e) => new GitHubError({ message: `${method} ${path}: ${e.message}` })))

/** A release by exact tag, or none when it does not exist yet. */
export const findRelease = (repo: string, tag: string) =>
  getJson(`/repos/${repo}/releases/tags/${tag}`, Release).pipe(
    Effect.asSome,
    Effect.catchTag("GitHubError", (e) =>
      e.message.includes("404") ? Effect.succeed(Option.none<Release>()) : Effect.fail(e),
    ),
  )

/** Download a small public asset into memory. */
export const fetchAssetText = (asset: Asset) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.followRedirects(10),
    )
    const res = yield* client.get(asset.browser_download_url, {
      headers: { "User-Agent": "auto-apk" },
    })
    return yield* res.text
  }).pipe(
    Effect.mapError((e) => new GitHubError({ message: `download ${asset.name}: ${e.message}` })),
  )

// ---------------------------------------------------------------- issues

const Issue = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
})
export type Issue = typeof Issue.Type

const Comment = Schema.Struct({ body: Schema.NullOr(Schema.String) })

/** The open issue with exactly this title and label, if any. */
export const findOpenIssue = Effect.fn("GitHub.findOpenIssue")(function* (
  repo: string,
  title: string,
  label: string,
) {
  const issues = yield* getJson(
    `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    Schema.Array(Issue),
  )
  return Option.fromNullishOr(issues.find((i) => i.title === title))
})

/** Bodies of the issue and all its comments, oldest first. */
export const issueTexts = Effect.fn("GitHub.issueTexts")(function* (repo: string, issue: Issue) {
  const comments = yield* getJson(
    `/repos/${repo}/issues/${issue.number}/comments?per_page=100`,
    Schema.Array(Comment),
  )
  return [issue.body ?? "", ...comments.map((c) => c.body ?? "")]
})

export const createIssue = (
  repo: string,
  title: string,
  body: string,
  labels: ReadonlyArray<string>,
) => sendJson("POST", `/repos/${repo}/issues`, { title, body, labels }, Issue)

export const commentIssue = (repo: string, issue: number, body: string) =>
  sendJson("POST", `/repos/${repo}/issues/${issue}/comments`, { body }, Comment)

export const closeIssue = (repo: string, issue: number) =>
  sendJson(
    "PATCH",
    `/repos/${repo}/issues/${issue}`,
    { state: "closed", state_reason: "completed" },
    Issue,
  )

/** The newest release on a channel: stable skips drafts and pre-releases. */
export const latestRelease = Effect.fn("GitHub.latestRelease")(function* (
  repo: string,
  channel: "stable" | "prerelease",
) {
  const releases = yield* getJson(`/repos/${repo}/releases?per_page=30`, Schema.Array(Release))
  const pick = releases.find((r) => !r.draft && (channel === "prerelease" ? true : !r.prerelease))
  if (!pick) return yield* new GitHubError({ message: `${repo} has no ${channel} release` })
  return pick
})

/** A release by tag; tries the tag as given and with a leading "v". */
export const releaseByTag = Effect.fn("GitHub.releaseByTag")(function* (
  repo: string,
  version: string,
) {
  const tags = version.startsWith("v") ? [version] : [`v${version}`, version]
  for (const tag of tags) {
    const found = yield* getJson(`/repos/${repo}/releases/tags/${tag}`, Release).pipe(Effect.option)
    if (Option.isSome(found)) return found.value
  }
  return yield* new GitHubError({ message: `${repo} has no release tagged ${tags.join(" or ")}` })
})

/** The one asset whose name matches `pattern`. */
export const pickAsset = (release: Release, pattern: string): Effect.Effect<Asset, GitHubError> => {
  const re = new RegExp(pattern)
  const matches = release.assets.filter((a) => re.test(a.name))
  if (matches.length === 1 && matches[0]) return Effect.succeed(matches[0])
  return Effect.fail(
    new GitHubError({
      message: `${release.tag_name}: ${matches.length} assets match ${pattern} (${release.assets.map((a) => a.name).join(", ")})`,
    }),
  )
}

/**
 * Stream `url` to `dest`, hashing as it goes. Fails, and removes the file, if the
 * SHA-256 or the size differs from what is expected. Returns the SHA-256.
 */
export const download = Effect.fn("download")(function* (
  url: string,
  dest: string,
  expect: { readonly sha256?: string | undefined; readonly size?: number | undefined } = {},
  headers: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.followRedirects(10),
  )
  yield* fs.makeDirectory(path.dirname(dest), { recursive: true })
  const partial = `${dest}.part`
  const hasher = new Bun.CryptoHasher("sha256")
  let size = 0

  const fail = (reason: string) => new DownloadError({ url, reason })
  const response = yield* client
    .get(url, { headers: { "User-Agent": "auto-apk", ...headers } })
    .pipe(Effect.mapError((e) => fail(e.message)))
  const type = response.headers["content-type"] ?? ""
  if (type.includes("text/html"))
    return yield* fail(`got ${type}, probably a challenge or error page`)

  yield* response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        hasher.update(chunk)
        size += chunk.length
      }),
    ),
    Stream.run(fs.sink(partial)),
    Effect.mapError((e) => fail(e.message)),
  )
  const sha256 = hasher.digest("hex")
  const problem =
    expect.sha256 && expect.sha256 !== sha256
      ? `SHA-256 is ${sha256}, expected ${expect.sha256}`
      : expect.size !== undefined && expect.size !== size
        ? `size is ${size}, expected ${expect.size}`
        : undefined
  if (problem) {
    yield* fs.remove(partial).pipe(Effect.ignore)
    return yield* fail(problem)
  }
  yield* fs.rename(partial, dest)
  return { path: dest, sha256, size }
})

/** Download a release asset, checked against GitHub's digest when it has one. */
export const downloadAsset = (asset: Asset, dest: string, sha256?: string) =>
  download(asset.browser_download_url, dest, {
    sha256: sha256 ?? asset.digest?.replace(/^sha256:/u, ""),
    size: asset.size,
  })
