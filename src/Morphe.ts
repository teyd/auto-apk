/**
 * Everything that runs the Morphe CLI. No other file runs the jar.
 *
 * When Morphe changes a flag or reshapes `list-versions` output or `result.json`,
 * this is the file to edit (see "Where a Morphe change lands" in PLAN.md).
 */
import { Data, Effect, FileSystem, Path, Schema } from "effect"
import type { Config } from "./Config.ts"
import * as GitHub from "./GitHub.ts"
import { runOk } from "./Process.ts"

export class PatchGateFailed extends Data.TaggedError("PatchGateFailed")<{
  readonly applied: number
  readonly expected: number
  readonly failed: ReadonlyArray<string>
  readonly success: boolean
}> {
  override get message() {
    return (
      `Morphe applied ${this.applied} of ${this.expected} patches` +
      (this.failed.length ? `; failed: ${this.failed.join(", ")}` : "") +
      (this.success ? "" : "; Morphe reported failure")
    )
  }
}

export class MorpheOutputError extends Data.TaggedError("MorpheOutputError")<{
  readonly message: string
}> {}

/** Download the pinned CLI jar once; later calls reuse it after checking its hash. */
export const ensureJar = Effect.fn("Morphe.ensureJar")(function* (
  tool: Config["tools"]["morphe"],
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const jar = path.join(cacheDir, "morphe", `morphe-${tool.version}.jar`)
  if (yield* fs.exists(jar)) {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(yield* fs.readFile(jar))
    if (hasher.digest("hex") === tool.sha256) return jar
    yield* fs.remove(jar)
  }
  const release = yield* GitHub.releaseByTag(tool.repo, tool.version)
  const asset = yield* GitHub.pickAsset(release, tool.asset)
  yield* GitHub.downloadAsset(asset, jar, tool.sha256)
  return jar
})

// ---------------------------------------------------------------- list-versions

export interface SupportedVersion {
  /** The app's versionName, exactly as Morphe and the APK report it. */
  readonly version: string
  /** How many default patches support it. */
  readonly patches: number
}

/** Natural order: 21.30.216 > 21.28.208, 12.41.0-prod.01 > 12.40.1-prod.01. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(/(\d+)/u)
  const pb = b.split(/(\d+)/u)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? ""
    const y = pb[i] ?? ""
    if (x === y) continue
    const nx = Number(x)
    const ny = Number(y)
    if (x !== "" && y !== "" && !Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Parse `list-versions` output, best first: most patches, then newest version.
 *
 *   Most common compatible versions:
 *   	351.11 - Stable [versionCodes: ARM64_V8A=351011, ...] (78 patches)
 *   	31.8.0 (42 patches)
 */
export const parseListVersions = (output: string): ReadonlyArray<SupportedVersion> =>
  output
    .split("\n")
    .flatMap((line) => {
      const m = /^\t(.+?) \((\d+) patch(?:es)?\)\s*$/u.exec(line)
      if (!m?.[1] || !m[2]) return []
      const version = m[1].replace(/\s*\[versionCodes:[^\]]*\]/u, "").trim()
      return [{ version, patches: Number(m[2]) }]
    })
    .toSorted((a, b) => b.patches - a.patches || compareVersions(b.version, a.version))

export const listVersions = Effect.fn("Morphe.listVersions")(function* (
  jar: string,
  bundle: string,
  packageName: string,
  experimental: boolean,
) {
  const args = ["-jar", jar, "list-versions", "--patches", bundle, "-f", packageName]
  if (experimental) args.push("--include-experimental")
  const { output } = yield* runOk("java", args)
  const versions = parseListVersions(output)
  if (versions.length === 0) {
    return yield* new MorpheOutputError({
      message: `list-versions gave no version for ${packageName}:\n${output.trim().slice(-800)}`,
    })
  }
  return versions
})

// ---------------------------------------------------------------- patch

const PatchResult = Schema.Struct({
  success: Schema.Boolean,
  packageName: Schema.String,
  packageVersion: Schema.String,
  appliedPatches: Schema.Array(Schema.String),
  failedPatches: Schema.Array(Schema.Unknown),
})
export type PatchResult = typeof PatchResult.Type

const failedName = (f: unknown): string =>
  typeof f === "string"
    ? f
    : typeof f === "object" && f !== null && "name" in f
      ? String(f.name)
      : JSON.stringify(f)

/**
 * The gate. Morphe exits 0 and reports success with 0 applied patches on a version
 * its patches do not support, so success alone means nothing.
 */
export const checkResult = (result: PatchResult, expected: number) => {
  const failed = result.failedPatches.map(failedName)
  const applied = result.appliedPatches.length
  return result.success && failed.length === 0 && applied === expected
    ? Effect.void
    : Effect.fail(new PatchGateFailed({ applied, expected, failed, success: result.success }))
}

export const patch = Effect.fn("Morphe.patch")(function* (opts: {
  readonly jar: string
  readonly jvmArgs: ReadonlyArray<string>
  readonly bundle: string
  readonly arch: string
  /** The stock APK, APKM or XAPK, passed as is. */
  readonly input: string
  readonly outDir: string
  /** Patch count `list-versions` reported for this version. */
  readonly expected: number
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const input = path.resolve(opts.input)
  const out = path.join(opts.outDir, "patched-unsigned.apk")
  const resultFile = path.join(opts.outDir, "result.json")
  const tmp = path.join(opts.outDir, "tmp")
  yield* fs.makeDirectory(opts.outDir, { recursive: true })
  for (const stale of [out, resultFile]) yield* fs.remove(stale, { force: true })

  yield* runOk("java", [
    ...opts.jvmArgs,
    "-jar",
    opts.jar,
    "patch",
    "-p",
    opts.bundle,
    "--striplibs",
    opts.arch,
    "-t",
    tmp,
    "--unsigned",
    "-o",
    out,
    "-r",
    resultFile,
    input,
  ])
  yield* fs.remove(tmp, { recursive: true, force: true })

  const text = yield* fs.readFileString(resultFile)
  const result = yield* Schema.decodeEffect(Schema.fromJsonString(PatchResult))(text).pipe(
    Effect.mapError(
      (e) =>
        new MorpheOutputError({ message: `result.json has an unexpected shape: ${e.message}` }),
    ),
  )
  yield* checkResult(result, opts.expected)
  return { apk: out, result }
})
