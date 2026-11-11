/**
 * The authenticity gate. A downloaded file is used only if every APK in it carries
 * the app's pinned certificate among its signers, and its package and version are
 * the ones asked for. An HTML challenge page saved as an "APK" fails here too.
 */
import { Data, Effect, FileSystem, Path } from "effect"
import { unzipSync } from "fflate"
import { run } from "./Process.ts"

export class VerifyFailed extends Data.TaggedError("VerifyFailed")<{
  readonly file: string
  readonly problems: ReadonlyArray<string>
  /** True when a valid signature is not the pinned one: possible tampering, not an outage. */
  readonly pinMismatch: boolean
}> {
  override get message() {
    return `${this.file} failed verification:\n${this.problems.map((p) => `  - ${p}`).join("\n")}`
  }
}

export interface Verified {
  readonly kind: "apk" | "apkm" | "xapk"
  readonly apks: number
  readonly package: string
  readonly versionName: string
  readonly versionCode: string
  /** Every signer certificate seen, SHA-256. */
  readonly certificates: ReadonlyArray<string>
}

/** Signer certificate digests from `apksigner verify --print-certs`, Source Stamp excluded. */
export const parseSignerCerts = (output: string): ReadonlyArray<string> =>
  [
    ...output.matchAll(/^(?!Source Stamp)[^\n]*certificate SHA-256 digest: ([0-9a-f]{64})$/gmu),
  ].flatMap((m) => (m[1] ? [m[1]] : []))

/** package name, versionCode and versionName from `aapt2 dump badging`. */
export const parseBadging = (output: string) => {
  const m = /package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/u.exec(output)
  return m ? { package: m[1] ?? "", versionCode: m[2] ?? "", versionName: m[3] ?? "" } : undefined
}

export const verify = Effect.fn("Verify.verify")(function* (
  file: string,
  want: { readonly package: string; readonly version: string; readonly signature: string },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const problems: Array<string> = []
  const failed = (pinMismatch = false) => new VerifyFailed({ file, problems, pinMismatch })

  const bytes = yield* fs.readFile(file)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    problems.push("not a zip file (an HTML page or a truncated download)")
    return yield* failed()
  }

  // Find out what kind of file this is, extracting only the APKs at the top level.
  const names: Array<string> = []
  const entries = yield* Effect.try({
    try: () =>
      unzipSync(bytes, {
        filter: (f) => {
          names.push(f.name)
          return f.name.endsWith(".apk") && !f.name.includes("/")
        },
      }),
    catch: (e) => {
      problems.push(`cannot read the zip: ${String(e)}`)
      return failed()
    },
  })

  let kind: Verified["kind"]
  let apks: Array<string>
  let base: string | undefined
  if (names.includes("AndroidManifest.xml")) {
    kind = "apk"
    apks = [file]
    base = file
  } else {
    kind = names.includes("info.json") ? "apkm" : "xapk"
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "verify-" })
    apks = []
    for (const [name, data] of Object.entries(entries)) {
      const out = path.join(dir, name)
      yield* fs.writeFile(out, data)
      apks.push(out)
    }
    base =
      apks.find((a) => path.basename(a) === "base.apk") ??
      apks.find((a) => path.basename(a) === `${want.package}.apk`) ??
      apks[0]
  }
  if (!base) {
    problems.push("no APK inside the bundle")
    return yield* failed()
  }

  const certificates = new Set<string>()
  let pinMissing = 0
  for (const apk of apks) {
    const { exitCode, output } = yield* run("apksigner", ["verify", "--print-certs", apk])
    const certs = parseSignerCerts(output)
    certs.forEach((c) => certificates.add(c))
    if (exitCode !== 0) problems.push(`${path.basename(apk)}: signature does not verify`)
    else if (!certs.includes(want.signature)) pinMissing++
  }
  if (pinMissing > 0) {
    problems.push(
      `${pinMissing} of ${apks.length} APKs are not signed by the pinned certificate ${want.signature.slice(0, 12)}… (signers seen: ${[...certificates].map((c) => c.slice(0, 12)).join(", ")})`,
    )
  }

  const badging = parseBadging((yield* run("aapt2", ["dump", "badging", base])).output)
  if (!badging) problems.push("aapt2 could not read the base APK's manifest")
  else {
    if (badging.package !== want.package)
      problems.push(`package is ${badging.package}, expected ${want.package}`)
    if (badging.versionName !== want.version) {
      problems.push(`version is ${badging.versionName}, expected ${want.version}`)
    }
  }

  if (problems.length > 0) return yield* failed(pinMissing > 0)
  return {
    kind,
    apks: apks.length,
    package: badging?.package ?? "",
    versionName: badging?.versionName ?? "",
    versionCode: badging?.versionCode ?? "",
    certificates: [...certificates],
  } satisfies Verified
}, Effect.scoped)
