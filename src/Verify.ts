/**
 * The authenticity gate. A downloaded file is used only if every APK in it carries
 * the app's pinned certificate among its signers, and its package and version are
 * the ones asked for. An HTML challenge page saved as an "APK" fails here too.
 */
import { Data, Effect, FileSystem, Path } from "effect"
import { unzipSync, zipSync } from "fflate"
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
  /**
   * The file to hand to Morphe. For a bundle this is a rebuilt copy holding exactly
   * the entries that were read and checked here, so a zip crafted to show one set of
   * entries to this reader and another to Morphe's cannot smuggle an unchecked split.
   * A single APK is passed as is: its v2/v3 signature covers the whole file.
   */
  readonly file: string
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

  // Single APK or bundle is decided by the file extension, the same way Morphe decides
  // whether to merge: .apkm, .xapk and .apks are unpacked and every entry ending in
  // .apk is merged, nested ones included. So every such entry must pass the pin.
  const ext = path.extname(file).toLowerCase()
  const isBundle = ext === ".apkm" || ext === ".xapk" || ext === ".apks"
  const names: Array<string> = []
  const entries = yield* Effect.try({
    try: () =>
      unzipSync(bytes, {
        filter: (f) => {
          names.push(f.name)
          return isBundle
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
  let output = file
  if (!isBundle) {
    if (ext !== ".apk") problems.push(`unexpected file type ${ext || "(none)"}`)
    if (!names.includes("AndroidManifest.xml")) problems.push("an .apk without AndroidManifest.xml")
    if (problems.length > 0) return yield* failed()
    kind = "apk"
    apks = [file]
    base = file
  } else {
    kind = ext === ".xapk" ? "xapk" : "apkm"
    const unsafe = names.filter(
      (n) => n.startsWith("/") || n.includes("\\") || n.split("/").includes(".."),
    )
    if (unsafe.length > 0) {
      problems.push(`unsafe entry names in the bundle: ${unsafe.slice(0, 5).join(", ")}`)
      return yield* failed()
    }
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "verify-" })
    apks = []
    for (const [name, data] of Object.entries(entries)) {
      if (!name.endsWith(".apk")) continue
      // Flatten nested names so every entry gets its own file to check.
      const out = path.join(dir, `${apks.length}-${name.replaceAll("/", "__")}`)
      yield* fs.writeFile(out, data)
      apks.push(out)
    }
    const nameOf = (a: string) => path.basename(a).replace(/^\d+-/u, "")
    base =
      apks.find((a) => nameOf(a) === "base.apk") ??
      apks.find((a) => nameOf(a) === `${want.package}.apk`) ??
      apks[0]
    // Rebuild the bundle from exactly what was read; see Verified.file.
    output = path.join(path.dirname(file), `verified-${path.basename(file)}`)
    yield* fs.writeFile(output, zipSync(entries, { level: 0 }))
  }
  if (!base) {
    problems.push("no APK inside the bundle")
    return yield* failed()
  }

  const certificates = new Set<string>()
  let pinMissing = 0
  for (const apk of apks) {
    const signer = yield* run("apksigner", ["verify", "--print-certs", apk])
    const certs = parseSignerCerts(signer.output)
    certs.forEach((c) => certificates.add(c))
    if (signer.exitCode !== 0) problems.push(`${path.basename(apk)}: signature does not verify`)
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

  if (problems.length > 0) {
    if (output !== file) yield* fs.remove(output, { force: true })
    return yield* failed(pinMissing > 0)
  }
  return {
    file: output,
    kind,
    apks: apks.length,
    package: badging?.package ?? "",
    versionName: badging?.versionName ?? "",
    versionCode: badging?.versionCode ?? "",
    certificates: [...certificates],
  } satisfies Verified
}, Effect.scoped)
