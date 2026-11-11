/**
 * The pin gate against real signatures. Needs apksigner and aapt2 on PATH and a
 * signed APK in AUTO_APK_FIXTURE_APK (any app; MicroG-RE 7.3.0 is used locally).
 * Skipped otherwise, so CI without the Android tools still passes.
 */
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { zipSync } from "fflate"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verify } from "../src/Verify.ts"

const fixture = process.env.AUTO_APK_FIXTURE_APK
const ready = Boolean(fixture && Bun.which("apksigner") && Bun.which("aapt2"))

const apk = ready ? readFileSync(fixture!) : new Uint8Array()
const meta = () => {
  const out = Bun.spawnSync(["apksigner", "verify", "--print-certs", fixture!]).stdout.toString()
  const signer =
    /^(?!Source Stamp)[^\n]*certificate SHA-256 digest: ([0-9a-f]{64})$/mu.exec(out)?.[1] ?? ""
  const badging = Bun.spawnSync(["aapt2", "dump", "badging", fixture!]).stdout.toString()
  const [, pkg = "", , version = ""] =
    /package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/u.exec(badging) ?? []
  return { signer, pkg, version }
}

const dir = mkdtempSync(join(tmpdir(), "verify-test-"))
const bundle = (name: string, files: Record<string, Uint8Array>) => {
  const path = join(dir, name)
  writeFileSync(path, zipSync(files, { level: 0 }))
  return path
}
const run = (file: string, signature: string) => {
  const m = meta()
  return Effect.runPromiseExit(
    verify(file, { package: m.pkg, version: m.version, signature }).pipe(
      Effect.provide(BunServices.layer),
    ),
  )
}
const reason = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "passed"

describe.skipIf(!ready)("Verify against real signatures", () => {
  const info = new TextEncoder().encode("{}")
  const unsigned = zipSync({ "AndroidManifest.xml": new Uint8Array([3, 0, 8, 0]) })

  test("a genuine APK passes with its own certificate", async () => {
    expect(Exit.isSuccess(await run(fixture!, meta().signer))).toBe(true)
  })

  test("the same APK fails with another pin", async () => {
    const exit = await run(fixture!, "0".repeat(64))
    expect(reason(exit)).toContain("not signed by the pinned certificate")
  })

  test("a bundle with only a genuine base.apk passes", async () => {
    const file = bundle("ok.apkm", { "info.json": info, "base.apk": apk })
    expect(Exit.isSuccess(await run(file, meta().signer))).toBe(true)
  })

  test("a nested unsigned split fails, even next to a genuine base.apk", async () => {
    const file = bundle("nested.apkm", {
      "info.json": info,
      "base.apk": apk,
      "extra/payload.apk": unsigned,
    })
    expect(reason(await run(file, meta().signer))).toContain(
      "payload.apk: signature does not verify",
    )
  })

  test("an entry that escapes the directory is refused", async () => {
    const file = bundle("slip.xapk", {
      "manifest.json": info,
      "base.apk": apk,
      "../evil.apk": unsigned,
    })
    expect(reason(await run(file, meta().signer))).toContain("unsafe entry names")
  })

  test("an HTML page saved as an .apk is refused", async () => {
    const path = join(dir, "challenge.apk")
    writeFileSync(path, "<!DOCTYPE html><title>Just a moment...</title>")
    expect(reason(await run(path, meta().signer))).toContain("not a zip file")
  })
})
