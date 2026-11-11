import { describe, expect, test } from "bun:test"
import { parseApkPureLink, pickVariant, protobufStrings } from "../src/Sources.ts"

/** Encode a protobuf length-delimited field (wire type 2). */
const field = (n: number, payload: Uint8Array): Uint8Array => {
  const len: Array<number> = []
  let v = payload.length
  while (v >= 0x80) {
    len.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  len.push(v)
  return new Uint8Array([(n << 3) | 2, ...len, ...payload])
}
const str = (s: string) => new TextEncoder().encode(s)
const cat = (...parts: Array<Uint8Array>) => new Uint8Array(parts.flatMap((p) => [...p]))

const link = (vn: string, t = "xapk", s = 158701762) => {
  const c = Buffer.from(
    `dev=Discord%20Inc.&t=${t}&s=${s}&vn=${encodeURIComponent(vn)}&vc=351011`,
  ).toString("base64url")
  return `https://download.pureapk.com/b/XAPK/abc?_fn=x&k=1&c=1%7CCOMMUNICATION%7C${c}`
}

describe("APKPure app API", () => {
  test("protobufStrings finds a long link nested two messages deep", () => {
    const url = link("351.11 - Stable")
    const msg = cat(
      field(1, str("version_list")),
      field(2, cat(field(3, str("com.discord")), field(9, str(url)))),
    )
    expect(protobufStrings(msg)).toContain(url)
  })

  test("parseApkPureLink reads version, type and size from the c parameter", () => {
    expect(parseApkPureLink(link("351.11 - Stable"))).toMatchObject({
      version: "351.11 - Stable",
      type: "xapk",
      size: 158701762,
    })
  })
})

const row = (text: string, href: string) =>
  `<div class="table-row headerFont"><a href="${href}">x</a> ${text} </div>`
const page = (...rows: Array<string>) => `<div class="variants-table">${rows.join("")}</div>`

describe("pickVariant (APKMirror release page)", () => {
  test("prefers a universal nodpi APK over an arm64 bundle", () => {
    const html = page(
      row(
        "21.30.216 BUNDLE arm64-v8a Android 10+ 480-640dpi",
        "/apk/g/yt/r/yt-1-android-apk-download/",
      ),
      row("21.30.216 APK universal Android 10+ nodpi", "/apk/g/yt/r/yt-2-android-apk-download/"),
    )
    expect(pickVariant(html, "arm64-v8a")?.href).toBe("/apk/g/yt/r/yt-2-android-apk-download/")
  })

  test("skips variants for another architecture", () => {
    const html = page(row("31.8.0 APK x86_64 nodpi", "/apk/t/t/r/t-1-android-apk-download/"))
    expect(pickVariant(html, "arm64-v8a")).toBeUndefined()
  })
})
