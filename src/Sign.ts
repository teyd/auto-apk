/**
 * Sign the built APKs. The only code that touches the keystore; it runs inside
 * `varlock run`, which loads the four signing values from Infisical for this one
 * process. Passwords stay Redacted until apksigner reads them from its environment
 * (never from its command line), and the keystore file is shredded when done.
 */
import { Data, Effect, FileSystem, Path, Redacted, Schema } from "effect"
import type { BuildRecord } from "./Build.ts"
import { generated as signingEnv } from "./env.generated.ts"
import { run, runOk } from "./Process.ts"
import { parseSignerCerts } from "./Verify.ts"

export class SignError extends Data.TaggedError("SignError")<{ readonly message: string }> {}

export const SignedApk = Schema.Struct({
  app: Schema.String,
  asset: Schema.String,
  sha256: Schema.String,
  size: Schema.Finite,
})
export type SignedApk = typeof SignedApk.Type

/** `signed/signing.json`: what `release` uploads. No secrets in it. */
export const SigningResult = Schema.Struct({
  certificateSha256: Schema.String,
  apks: Schema.Array(SignedApk),
})
export type SigningResult = typeof SigningResult.Type

/** A URL-safe file name. GitHub turns spaces in asset names into dots anyway. */
export const safeName = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")

export const assetName = (template: string, record: BuildRecord, arch: string): string =>
  template
    .replaceAll("{app}", record.app)
    .replaceAll("{appVersion}", safeName(record.version ?? "unknown"))
    .replaceAll("{patchesVersion}", safeName(record.patches.tag.replace(/^v/u, "")))
    .replaceAll("{arch}", arch)

export const signAll = Effect.fn("signAll")(function* (
  items: ReadonlyArray<{
    readonly record: BuildRecord
    readonly unsigned: string
    readonly asset: string
  }>,
  outDir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const env = yield* signingEnv
  yield* fs.makeDirectory(outDir, { recursive: true })

  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sign-" })
  const keystore = path.join(dir, "release.p12")
  yield* Effect.acquireRelease(
    fs.writeFile(keystore, Buffer.from(Redacted.value(env.KEYSTORE_BASE64), "base64"), {
      mode: 0o600,
    }),
    () => run("shred", ["-u", keystore]).pipe(Effect.ignore),
  )
  const secrets = { KS_PASS: env.KEYSTORE_PASSWORD, KEY_PASS: env.KEY_PASSWORD }

  const signed: Array<SignedApk> = []
  let certificate: string | undefined
  for (const item of items) {
    const out = path.join(outDir, item.asset)
    yield* runOk(
      "apksigner",
      [
        "sign",
        "--ks",
        keystore,
        "--ks-type",
        "PKCS12",
        "--ks-pass",
        "env:KS_PASS",
        "--ks-key-alias",
        env.KEY_ALIAS,
        "--key-pass",
        "env:KEY_PASS",
        "--v4-signing-enabled",
        "false",
        "--out",
        out,
        item.unsigned,
      ],
      { env: secrets },
    ).pipe(
      Effect.mapError(
        (e) =>
          new SignError({
            message: `${item.record.app}: apksigner sign failed (${e._tag === "CommandFailed" ? `exit ${e.exitCode}` : e.message})`,
          }),
      ),
    )

    const check = yield* runOk("apksigner", ["verify", "--print-certs", out])
    const cert = parseSignerCerts(check.output)[0]
    if (!cert)
      return yield* new SignError({ message: `${item.record.app}: no signer after signing` })
    if (certificate && cert !== certificate) {
      return yield* new SignError({
        message: `${item.record.app}: signed with a different certificate`,
      })
    }
    certificate = cert

    const bytes = yield* fs.readFile(out)
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(bytes)
    signed.push({
      app: item.record.app,
      asset: item.asset,
      sha256: hasher.digest("hex"),
      size: bytes.length,
    })
  }
  const result: SigningResult = { certificateSha256: certificate ?? "", apks: signed }
  yield* fs.writeFileString(
    path.join(outDir, "signing.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  return result
}, Effect.scoped)
