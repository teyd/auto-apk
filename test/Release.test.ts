import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { BuildRecord } from "../src/Build.ts"
import { decodeConfig } from "../src/Config.ts"
import type { Manifest } from "../src/Manifest.ts"
import { releaseNotes } from "../src/Release.ts"
import { assetName, safeName } from "../src/Sign.ts"

const config = Effect.runSync(decodeConfig("auto-apk.json", await Bun.file("auto-apk.json").json()))

const record = (app: string, version: string, tag: string): BuildRecord => ({
  app,
  status: "built",
  version,
  patches: { repo: "r/p", tag, asset: "patches.mpp", sha256: "x" },
  morphe: "2.1.1",
  attempts: [],
  finishedAt: "2026-11-11T22:00:00Z",
})

describe("asset names", () => {
  test("follow publish.asset, without the patches tag's v", () => {
    expect(
      assetName(config.publish.asset, record("youtube", "21.30.216", "v2.2.0"), "arm64-v8a"),
    ).toBe("youtube-21.30.216-p2.2.0-arm64-v8a.apk")
  })

  test("spaces and odd characters become dashes", () => {
    expect(safeName("351.11 - Stable")).toBe("351.11-Stable")
    expect(
      assetName(config.publish.asset, record("discord", "351.11 - Stable", "v1.21.1"), "arm64-v8a"),
    ).toBe("discord-351.11-Stable-p1.21.1-arm64-v8a.apk")
  })
})

describe("releaseNotes", () => {
  const manifest: Manifest = {
    manifestVersion: 1,
    apps: {
      youtube: {
        appVersion: "21.30.216",
        patches: { repo: "MorpheApp/morphe-patches", tag: "v2.2.0", sha256: "x" },
        morphe: "2.1.1",
        inputKey: "k",
        asset: "youtube-21.30.216-p2.2.0-arm64-v8a.apk",
        apkSha256: "a",
        builtAt: "2026-11-11T22:00:00Z",
      },
    },
  }

  test("carry the certificate and one row per published app", () => {
    const notes = releaseNotes(config, manifest, "c0ffee")
    expect(notes).toContain("Signing certificate SHA-256: `c0ffee`")
    expect(notes).toContain("| YouTube | 21.30.216 |")
    expect(notes).not.toContain("| Reddit |")
  })
})
