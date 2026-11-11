import { describe, expect, test } from "bun:test"
import { parseBadging, parseSignerCerts } from "../src/Verify.ts"

// YouTube 21.30.216 from APKMirror: a rotated v3.1 key next to the original v3.0 key.
const YOUTUBE = `Signer #1 certificate DN: CN=Unknown
V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate DN: CN=Android, OU=Android, O=Google Inc.
V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: 5aad2bee6db95d17e05a08d7d1e64c10a1511879154483916b6ae6c7fd9cb0c6
V3.0 Signer: (minSdkVersion=24, maxSdkVersion=32) certificate DN: CN=Unknown, OU="Google, Inc"
V3.0 Signer: (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: 3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a
Source Stamp Signer: certificate SHA-256 digest: 3257d599a49d2c961a471ca9843f59d341a405884583fc087df4237b733bbd6d
`

describe("parseSignerCerts", () => {
  test("finds both the original and the rotated signer", () => {
    expect(parseSignerCerts(YOUTUBE)).toEqual([
      "5aad2bee6db95d17e05a08d7d1e64c10a1511879154483916b6ae6c7fd9cb0c6",
      "3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a",
    ])
  })

  test("ignores the Source Stamp, which is Google Play's, not the publisher's", () => {
    expect(parseSignerCerts(YOUTUBE)).not.toContain(
      "3257d599a49d2c961a471ca9843f59d341a405884583fc087df4237b733bbd6d",
    )
  })

  test("an unsigned or unreadable file has no signers", () => {
    expect(parseSignerCerts("DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF\n")).toEqual([])
  })
})

describe("parseBadging", () => {
  test("reads package, versionCode and versionName, spaces included", () => {
    expect(
      parseBadging(
        "package: name='com.discord' versionCode='351011' versionName='351.11 - Stable' platformBuildVersionName='15'\n",
      ),
    ).toEqual({ package: "com.discord", versionCode: "351011", versionName: "351.11 - Stable" })
  })

  test("returns undefined when aapt2 printed no package line", () => {
    expect(parseBadging("W/ResourceType: bad XML block\n")).toBeUndefined()
  })
})
