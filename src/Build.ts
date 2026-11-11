/**
 * Build one app: patches release -> supported version -> stock APK from the first
 * source that passes verification -> Morphe patch -> patch-count gate.
 *
 * Writes `<out>/<app>/build.json` either way, so the report job can say exactly
 * what happened, and the unsigned APK on success. Holds no secrets.
 */
import { Data, Effect, FileSystem, Path } from "effect"
import type { Config, ResolvedApp } from "./Config.ts"
import * as GitHub from "./GitHub.ts"
import * as Morphe from "./Morphe.ts"
import * as Sources from "./Sources.ts"
import { verify } from "./Verify.ts"

/** How many of Morphe's ranked versions to try before giving up. */
const MAX_VERSIONS = 3

export interface Attempt {
  readonly version: string
  readonly source: string
  readonly ok: boolean
  readonly error?: string
  /** A correctly signed file not signed by the pinned certificate: possible tampering. */
  readonly pinMismatch?: boolean
}

export interface BuildRecord {
  readonly app: string
  readonly status: "built" | "failed"
  readonly reason?: string
  readonly patches: {
    readonly repo: string
    readonly tag: string
    readonly asset: string
    readonly sha256: string
  }
  readonly morphe: string
  readonly version?: string
  readonly expectedPatches?: number
  readonly appliedPatches?: number
  readonly source?: string
  readonly input?: { readonly from: string; readonly sha256: string; readonly kind: string }
  readonly apk?: { readonly file: string; readonly sha256: string; readonly size: number }
  readonly attempts: ReadonlyArray<Attempt>
  readonly finishedAt: string
}

export class BuildFailed extends Data.TaggedError("BuildFailed")<{ readonly record: BuildRecord }> {
  override get message() {
    const lines = this.record.attempts.map(
      (a) =>
        `  ${a.version} ${a.source}: ${a.ok ? "ok" : a.error}${a.pinMismatch ? " [PIN MISMATCH]" : ""}`,
    )
    return `${this.record.app}: ${this.record.reason}\n${lines.join("\n")}`
  }
}

const sha256File = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(yield* fs.readFile(file))
    return hasher.digest("hex")
  })

export const buildApp = Effect.fn("buildApp")(function* (
  config: Config,
  app: ResolvedApp,
  options: {
    readonly workDir: string
    readonly outDir: string
    readonly version?: string | undefined
  },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cache = path.join(options.workDir, "cache")
  const outDir = path.join(options.outDir, app.id)
  const dlDir = path.join(options.workDir, "dl", app.id)
  yield* fs.remove(outDir, { recursive: true, force: true })
  yield* fs.makeDirectory(outDir, { recursive: true })
  yield* fs.makeDirectory(dlDir, { recursive: true })

  // Patch bundle: latest release on the channel, cached by tag.
  const release = yield* GitHub.latestRelease(app.patches.repo, app.patches.channel)
  const asset = yield* GitHub.pickAsset(release, app.patches.asset)
  const bundle = path.join(
    cache,
    "bundles",
    app.patches.repo.replace("/", "__"),
    release.tag_name,
    asset.name,
  )
  const bundleSha = (yield* fs.exists(bundle))
    ? yield* sha256File(bundle)
    : (yield* GitHub.downloadAsset(asset, bundle)).sha256
  yield* Effect.log(`${app.id}: patches ${app.patches.repo} ${release.tag_name}`)

  const jar = yield* Morphe.ensureJar(config.tools.morphe, cache)
  const supported = yield* Morphe.listVersions(jar, bundle, app.package, app.experimental)

  // Which versions to try: an explicit or held version, or Morphe's ranking.
  const held = options.version ?? (app.version === "auto" ? undefined : app.version)
  const candidates = held
    ? supported.filter((v) => v.version === held)
    : supported.slice(0, MAX_VERSIONS)

  const attempts: Array<Attempt> = []
  const base = {
    app: app.id,
    patches: {
      repo: app.patches.repo,
      tag: release.tag_name,
      asset: asset.name,
      sha256: bundleSha,
    },
    morphe: config.tools.morphe.version,
  }
  const finish = (record: Omit<BuildRecord, keyof typeof base | "attempts" | "finishedAt">) =>
    Effect.gen(function* () {
      const full: BuildRecord = {
        ...base,
        ...record,
        attempts,
        finishedAt: new Date().toISOString(),
      }
      yield* fs.writeFileString(
        path.join(outDir, "build.json"),
        `${JSON.stringify(full, null, 2)}\n`,
      )
      return full
    })

  if (candidates.length === 0) {
    const record = yield* finish({
      status: "failed",
      reason: `version ${held} is not supported by ${app.patches.repo} ${release.tag_name} (supported: ${supported.map((v) => v.version).join(", ")})`,
    })
    return yield* new BuildFailed({ record })
  }

  const flare = yield* Sources.makeFlareSolverr(config.tools.flaresolverr.image)

  for (const candidate of candidates) {
    const want = { package: app.package, version: candidate.version, arch: app.arch }
    for (const source of app.sources) {
      yield* Effect.log(`${app.id}: ${candidate.version} from ${source.name}`)
      const fetched =
        source.name === "apkmirror"
          ? yield* Effect.result(Sources.apkmirror(flare, source.url, want, dlDir))
          : source.name === "apkpure"
            ? yield* Effect.result(Sources.apkpure(want, dlDir))
            : yield* Effect.result(Sources.archive(source.url, want, dlDir))
      if (fetched._tag === "Failure") {
        const f = fetched.failure
        attempts.push({
          version: candidate.version,
          source: source.name,
          ok: false,
          error: f._tag === "SourceError" ? f.reason : f.message,
        })
        continue
      }
      const file = fetched.success.file
      const checked = yield* verify(file, { ...want, signature: app.signature }).pipe(Effect.result)
      if (checked._tag === "Failure") {
        const f = checked.failure
        attempts.push({
          version: candidate.version,
          source: source.name,
          ok: false,
          error: f._tag === "VerifyFailed" ? f.problems.join("; ") : f.message,
          ...(f._tag === "VerifyFailed" && f.pinMismatch ? { pinMismatch: true } : {}),
        })
        yield* fs.remove(file, { force: true })
        continue
      }
      attempts.push({ version: candidate.version, source: source.name, ok: true })
      const inputSha = yield* sha256File(file)
      const verified = checked.success.file

      // Patch. A gate failure is not a download problem, so it ends the build.
      const patched = yield* Morphe.patch({
        jar,
        jvmArgs: config.tools.morphe.jvmArgs,
        bundle,
        arch: app.arch,
        input: verified,
        outDir,
        expected: candidate.patches,
      }).pipe(Effect.result)
      for (const f of [file, verified]) yield* fs.remove(f, { force: true })
      if (patched._tag === "Failure") {
        const record = yield* finish({
          status: "failed",
          reason: `patching ${candidate.version} failed: ${patched.failure.message}`,
          version: candidate.version,
          expectedPatches: candidate.patches,
          ...(patched.failure._tag === "PatchGateFailed"
            ? { appliedPatches: patched.failure.applied }
            : {}),
          source: source.name,
          input: { from: fetched.success.from, sha256: inputSha, kind: checked.success.kind },
        })
        return yield* new BuildFailed({ record })
      }
      const apk = patched.success.apk
      const stat = yield* fs.stat(apk)
      const record = yield* finish({
        status: "built",
        version: candidate.version,
        expectedPatches: candidate.patches,
        appliedPatches: patched.success.result.appliedPatches.length,
        source: source.name,
        input: { from: fetched.success.from, sha256: inputSha, kind: checked.success.kind },
        apk: { file: apk, sha256: yield* sha256File(apk), size: Number(stat.size) },
      })
      yield* Effect.log(
        `${app.id}: built ${candidate.version} from ${source.name}, ${record.appliedPatches}/${record.expectedPatches} patches`,
      )
      return record
    }
  }

  const record = yield* finish({
    status: "failed",
    reason: `no source had a verified copy of ${candidates.map((c) => c.version).join(" or ")}`,
  })
  return yield* new BuildFailed({ record })
}, Effect.scoped)
