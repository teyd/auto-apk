import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { checkResult, compareVersions, parseListVersions } from "../src/Morphe.ts"

// Real `list-versions` output from Morphe 2.1.1, captured in Phase 0.
const X = `INFO: Package name: com.twitter.android
Most common compatible versions:
\t12.38.1-prod.01 (46 patches)
\t12.39.0-prod.01 (46 patches)
\t12.40.1-prod.01 (46 patches)
\t12.41.0-prod.01 (46 patches)
`
const DISCORD = `INFO: Package name: com.discord
Most common compatible versions:
\t351.11 - Stable [versionCodes: ARM64_V8A=351011, ARMEABI_V7A=351011, X86_64=351011, X86=351011] (78 patches)
`
const REDDIT = `Most common compatible versions:
\t2026.40.0 (30 patches)
\t2026.24.0 (30 patches)
\t2026.10.0 (30 patches)
\t2024.02.0 (1 patch)
`
const GBOARD = `Most common compatible versions:
\t18.5.4.993608717-release-arm64-v8a (45 patches)
`

describe("parseListVersions", () => {
  test("ties go to the newest version, even though Morphe lists them oldest first", () => {
    expect(parseListVersions(X).map((v) => v.version)).toEqual([
      "12.41.0-prod.01",
      "12.40.1-prod.01",
      "12.39.0-prod.01",
      "12.38.1-prod.01",
    ])
  })

  test("versionCodes are dropped and suffixes like ' - Stable' kept", () => {
    expect(parseListVersions(DISCORD)).toEqual([{ version: "351.11 - Stable", patches: 78 }])
  })

  test("more patches wins over newer, and '1 patch' parses", () => {
    expect(parseListVersions(REDDIT).at(0)).toEqual({ version: "2026.40.0", patches: 30 })
    expect(parseListVersions(REDDIT).at(-1)).toEqual({ version: "2024.02.0", patches: 1 })
  })

  test("full Gboard version names survive", () => {
    expect(parseListVersions(GBOARD)).toEqual([
      { version: "18.5.4.993608717-release-arm64-v8a", patches: 45 },
    ])
  })

  test("no version lines gives an empty list", () => {
    expect(parseListVersions("INFO: nothing here\n")).toEqual([])
  })
})

describe("compareVersions", () => {
  test("numeric parts compare as numbers", () => {
    expect(compareVersions("21.30.216", "21.28.208")).toBeGreaterThan(0)
    expect(compareVersions("2026.9.0", "2026.10.0")).toBeLessThan(0)
    expect(compareVersions("12.41.0-prod.01", "12.40.1-prod.01")).toBeGreaterThan(0)
    expect(compareVersions("31.8.0", "31.8.0")).toBe(0)
  })
})

const result = (applied: number, failed: ReadonlyArray<unknown> = [], success = true) => ({
  success,
  packageName: "com.google.android.youtube",
  packageVersion: "21.31.524",
  appliedPatches: Array.from({ length: applied }, (_, i) => `patch ${i}`),
  failedPatches: failed,
})
const passes = (r: ReturnType<typeof result>, expected: number) =>
  Exit.isSuccess(Effect.runSyncExit(checkResult(r, expected)))

describe("checkResult (the patch-count gate)", () => {
  test("passes only when every expected patch applied", () => {
    expect(passes(result(113), 113)).toBe(true)
  })

  test("fails Morphe's 'success' with 0 patches on an unsupported version", () => {
    expect(passes(result(0), 113)).toBe(false)
  })

  test("fails a partial patch, a failed patch, or reported failure", () => {
    expect(passes(result(112), 113)).toBe(false)
    expect(passes(result(113, [{ name: "Hide ads" }]), 113)).toBe(false)
    expect(passes(result(113, [], false), 113)).toBe(false)
  })
})
