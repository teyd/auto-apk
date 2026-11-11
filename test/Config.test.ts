import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { type Config, decodeConfig, jsonSchema, resolveApp } from "../src/Config.ts"

const real = (await Bun.file("auto-apk.json").json()) as Record<string, unknown>
const clone = (): any => structuredClone(real)

const decode = (json: unknown) => Effect.runPromiseExit(decodeConfig("test.json", json))

const problems = async (json: unknown): Promise<string> => {
  const exit = await decode(json)
  if (Exit.isSuccess(exit)) throw new Error("expected the config to be rejected")
  return String(exit.cause)
}

describe("auto-apk.json", () => {
  test("the committed config is valid", async () => {
    expect(Exit.isSuccess(await decode(real))).toBe(true)
  })

  test("the committed JSON Schema matches src/Config.ts", async () => {
    const committed = await Bun.file("schema/auto-apk.schema.json").text()
    expect(committed).toBe(`${JSON.stringify(jsonSchema(), null, 2)}\n`)
  })
})

describe("rejected configs", () => {
  test("an unknown key (a typo) is an error, not ignored", async () => {
    const c = clone()
    c.apps.youtube.signatur = c.apps.youtube.signature
    expect(await problems(c)).toContain("signatur")
  })

  test("a signature that is not a SHA-256", async () => {
    const c = clone()
    c.apps.youtube.signature = "3d7a1223"
    expect(await problems(c)).toContain("signature")
  })

  test("an unknown source name", async () => {
    const c = clone()
    c.defaults.sources = ["apkmirror", "uptodown"]
    expect(await problems(c)).toContain(
      'defaults.sources[1]: Expected "apkmirror" | "apkpure" | "archive"',
    )
  })

  test("an app with no usable source", async () => {
    const c = clone()
    c.defaults.sources = ["archive"]
    expect(await problems(c)).toContain("apps.instagram: none of its sources")
  })

  test("two apps with the same package", async () => {
    const c = clone()
    c.apps.youtube2 = c.apps.youtube
    expect(await problems(c)).toContain("same package com.google.android.youtube")
  })

  test("an invalid regular expression", async () => {
    const c = clone()
    c.defaults.patches.asset = "^patches(.mpp$"
    expect(await problems(c)).toContain("defaults.patches.asset: not a valid regular expression")
  })

  test("an asset name without {appVersion}", async () => {
    const c = clone()
    c.publish.asset = "{app}.apk"
    expect(await problems(c)).toContain("asset")
  })

  test("a FlareSolverr image not pinned by digest", async () => {
    const c = clone()
    c.tools.flaresolverr.image = "ghcr.io/flaresolverr/flaresolverr:latest"
    expect(await problems(c)).toContain("image")
  })
})

const config = (overrides: (draft: any) => void = () => {}): Config => {
  const draft = clone()
  overrides(draft)
  return Effect.runSync(decodeConfig("test.json", draft))
}

describe("resolveApp", () => {
  test("takes every unset key from defaults", () => {
    const c = config()
    const yt = resolveApp(c, "youtube", c.apps.youtube!)
    expect(yt).toMatchObject({
      enabled: true,
      arch: "arm64-v8a",
      experimental: false,
      version: "auto",
      patches: { repo: "MorpheApp/morphe-patches", asset: "^patches.*\\.mpp$", channel: "stable" },
    })
  })

  test("an app overrides a default by repeating the key", () => {
    const c = config((d) => {
      d.apps.youtube.version = "21.30.216"
      d.apps.youtube.enabled = false
      d.apps.youtube.patches.channel = "prerelease"
    })
    const yt = resolveApp(c, "youtube", c.apps.youtube!)
    expect(yt.version).toBe("21.30.216")
    expect(yt.enabled).toBe(false)
    expect(yt.patches.channel).toBe("prerelease")
  })

  test("sources follow the defaults order and skip what the app does not list", () => {
    const c = config((d) => {
      d.defaults.sources = ["archive", "apkpure", "apkmirror"]
    })
    expect(resolveApp(c, "youtube", c.apps.youtube!).sources.map((s) => s.name)).toEqual([
      "archive",
      "apkpure",
      "apkmirror",
    ])
    expect(resolveApp(c, "instagram", c.apps.instagram!).sources.map((s) => s.name)).toEqual([
      "apkpure",
      "apkmirror",
    ])
  })
})
