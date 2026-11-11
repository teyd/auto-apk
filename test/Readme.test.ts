import { expect, test } from "bun:test"
import { Effect } from "effect"
import { decodeConfig } from "../src/Config.ts"
import { addLink, appEntry } from "../src/Obtainium.ts"
import { renderReadme } from "../src/Readme.ts"
import { resolveApps } from "../src/Config.ts"

const config = Effect.runSync(decodeConfig("auto-apk.json", await Bun.file("auto-apk.json").json()))

test("the README app table matches auto-apk.json (run: bun src/main.ts readme)", async () => {
  const readme = await Bun.file("README.md").text()
  expect(readme).toBe(renderReadme(readme, config))
})

test("an Obtainium link round-trips to the app's settings", () => {
  const youtube = resolveApps(config).find((a) => a.id === "youtube")!
  const link = new URL(addLink(appEntry(config, youtube)))
  const inner = link.searchParams.get("r")!
  expect(inner.startsWith("obtainium://app/")).toBe(true)
  const entry = JSON.parse(decodeURIComponent(inner.slice("obtainium://app/".length)))
  expect(entry.id).toBe("com.google.android.youtube")
  expect(JSON.parse(entry.additionalSettings)).toEqual({
    filterReleaseTitlesByRegEx: "^youtube-",
    fallbackToOlderReleases: true,
  })
})
