import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Asset } from "../src/GitHub.ts"
import { decodeConfig, resolveApps } from "../src/Config.ts"
import { inputKey } from "../src/Plan.ts"

const config = Effect.runSync(decodeConfig("auto-apk.json", await Bun.file("auto-apk.json").json()))
const app = (id: string) => resolveApps(config).find((a) => a.id === id)!
const asset: Asset = {
  name: "patches-2.2.0.mpp",
  size: 100,
  browser_download_url: "https://example.invalid/x.mpp",
  digest: "sha256:aaaa",
}
const key = (patchTag = "v2.2.0", over: Partial<Asset> = {}, appId = "youtube") =>
  inputKey(config, app(appId), { tag: patchTag, asset: { ...asset, ...over } })

describe("inputKey (what makes plan rebuild an app)", () => {
  test("the same inputs give the same key, so nothing is rebuilt", () => {
    expect(key()).toBe(key())
  })

  test("a new patch release, or a different bundle, changes it", () => {
    expect(key("v2.3.0")).not.toBe(key())
    expect(key("v2.2.0", { digest: "sha256:bbbb" })).not.toBe(key())
    // No digest from GitHub: the size is the fallback, so a different size still counts.
    expect(key("v2.2.0", { digest: undefined, size: 101 })).not.toBe(
      key("v2.2.0", { digest: undefined, size: 100 }),
    )
  })

  test("the Morphe jar and the app's own settings are part of it", () => {
    const otherMorphe = {
      ...config,
      tools: { ...config.tools, morphe: { ...config.tools.morphe, sha256: "0".repeat(64) } },
    }
    expect(inputKey(otherMorphe, app("youtube"), { tag: "v2.2.0", asset })).not.toBe(key())
    const pinned = {
      ...config,
      apps: { ...config.apps, youtube: { ...config.apps.youtube!, version: "21.30.216" } },
    }
    const pinnedApp = resolveApps(pinned).find((a) => a.id === "youtube")!
    expect(inputKey(pinned, pinnedApp, { tag: "v2.2.0", asset })).not.toBe(key())
  })

  test("different apps are independent", () => {
    expect(key("v2.2.0", {}, "youtube")).not.toBe(key("v2.2.0", {}, "reddit"))
  })
})
