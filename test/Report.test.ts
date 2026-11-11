import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuildRecord } from "../src/Build.ts"
import { fingerprint, issueBody, missingRecord, readRecords } from "../src/Report.ts"

const failed = (error: string, pinMismatch = false): BuildRecord => ({
  app: "youtube",
  status: "failed",
  reason: "no source had a verified copy of 21.30.216",
  patches: {
    repo: "MorpheApp/morphe-patches",
    tag: "v2.2.0",
    asset: "patches-2.2.0.mpp",
    sha256: "x",
  },
  morphe: "2.1.1",
  attempts: [
    {
      version: "21.30.216",
      source: "apkmirror",
      ok: false,
      error,
      ...(pinMismatch ? { pinMismatch } : {}),
    },
  ],
  finishedAt: "2026-11-11T00:00:00Z",
})

describe("fingerprint", () => {
  test("ignores per-run URLs and keys, so a lasting outage is reported once", () => {
    const a = failed(
      "file: HTTP 403 https://www.apkmirror.com/download.php?id=1&key=8c832d448ddc213922606fcd8ece31a2c19d723b",
    )
    const b = failed(
      "file: HTTP 403 https://www.apkmirror.com/download.php?id=2&key=0000000000000000000000000000000000000000",
    )
    expect(fingerprint(a)).toBe(fingerprint(b))
  })

  test("changes when the reason changes", () => {
    expect(fingerprint(failed("file: HTTP 403"))).not.toBe(
      fingerprint(failed("no release page for 21.30.216")),
    )
  })
})

describe("issueBody", () => {
  test("a pin mismatch is called out at the top", () => {
    const body = issueBody(failed("not signed by the pinned certificate", true), "https://run")
    expect(body.startsWith("> [!CAUTION]")).toBe(true)
    expect(body).toContain("**pin mismatch**")
  })

  test("an ordinary failure has no caution, and carries its fingerprint", () => {
    const record = failed("file: HTTP 403")
    const body = issueBody(record, "https://run")
    expect(body).not.toContain("CAUTION")
    expect(body).toContain(`auto-apk:reason=${fingerprint(record)}`)
  })

  test("table cells cannot break the table", () => {
    expect(issueBody(failed("a | b\nc"), "https://run")).toContain("a \\| b c")
    expect(issueBody(failed("a \\| b"), "https://run")).toContain("a \\\\\\| b")
  })
})

test("a leg without a record counts as a failure", () => {
  expect(missingRecord("tiktok")).toMatchObject({ app: "tiktok", status: "failed" })
})

const built = (app: string): BuildRecord => ({ ...failed("x"), app, status: "built", attempts: [] })
const read = (dir: string, apps: Array<string>) =>
  Effect.runPromise(readRecords(dir, apps).pipe(Effect.provide(BunServices.layer)))

describe("readRecords", () => {
  test("one artifact unpacked straight into the folder (a one-app run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"))
    writeFileSync(join(dir, "build.json"), JSON.stringify(built("x")))
    expect((await read(dir, ["x"])).map((r) => r.status)).toEqual(["built"])
  })

  test("several artifacts in their own folders, and one leg that wrote nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"))
    for (const app of ["x", "twitch"]) {
      mkdirSync(join(dir, `record-${app}`))
      writeFileSync(join(dir, `record-${app}`, "build.json"), JSON.stringify(built(app)))
    }
    const records = await read(dir, ["x", "twitch", "tiktok"])
    expect(records.map((r) => `${r.app}:${r.status}`)).toEqual([
      "x:built",
      "twitch:built",
      "tiktok:failed",
    ])
  })

  test("a missing folder means every app failed", async () => {
    expect((await read(join(tmpdir(), "does-not-exist-auto-apk"), ["x"]))[0]?.status).toBe("failed")
  })
})
