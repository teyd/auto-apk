/**
 * Publish signed APKs to the one rolling release. Uploads each new APK before
 * deleting the app's old one, so the release never lacks an app; other apps'
 * files are not touched. Then writes manifest.json and the release notes from it.
 * Needs a token with contents: write; never sees the keystore.
 */
import { Effect, FileSystem, Option, Path } from "effect"
import type { BuildRecord } from "./Build.ts"
import type { Config } from "./Config.ts"
import * as GitHub from "./GitHub.ts"
import { MANIFEST_ASSET, type Manifest, readManifest } from "./Manifest.ts"
import { runOk } from "./Process.ts"
import type { SigningResult } from "./Sign.ts"

const gh = (args: ReadonlyArray<string>) => runOk("gh", args)

export const releaseNotes = (config: Config, manifest: Manifest, certificate: string): string => {
  const ids = Object.keys(config.apps).filter((id) => manifest.apps[id])
  const rows = ids.map((id) => {
    const e = manifest.apps[id]!
    const name = config.apps[id]?.name ?? id
    return `| ${name} | ${e.appVersion} | [${e.patches.repo}](https://github.com/${e.patches.repo}) ${e.patches.tag} | \`${e.asset}\` | ${e.builtAt.slice(0, 10)} |`
  })
  return [
    "Unofficial, Morphe-patched builds. Each app's file is replaced when its patches change.",
    "",
    `Signing certificate SHA-256: \`${certificate}\``,
    "",
    "| App | Version | Patches | File | Built |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "Provenance: `gh attestation verify <file>.apk --repo " + config.publish.repo + "`",
  ].join("\n")
}

export const publish = Effect.fn("publish")(function* (
  config: Config,
  records: ReadonlyArray<BuildRecord>,
  signed: SigningResult,
  signedDir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { repo, tag } = config.publish

  if (Option.isNone(yield* GitHub.findRelease(repo, tag))) {
    yield* gh([
      "release",
      "create",
      tag,
      "-R",
      repo,
      "--title",
      "Latest builds",
      "--notes",
      "Preparing…",
      "--latest",
    ])
  }
  const manifest = yield* readManifest(repo, tag)
  const apps = { ...manifest.apps }
  const published: Array<string> = []

  for (const apk of signed.apks) {
    const record = records.find((r) => r.app === apk.app)
    if (!record?.version || !record.inputKey) continue
    yield* gh(["release", "upload", tag, "-R", repo, "--clobber", path.join(signedDir, apk.asset)])

    // Remove this app's previous files only after the new one is up.
    const release = yield* GitHub.findRelease(repo, tag)
    const old = Option.match(release, {
      onNone: () => [],
      onSome: (r) =>
        r.assets.filter(
          (a) =>
            a.name.startsWith(`${apk.app}-`) && a.name.endsWith(".apk") && a.name !== apk.asset,
        ),
    })
    for (const a of old) yield* gh(["release", "delete-asset", tag, a.name, "-R", repo, "--yes"])

    apps[apk.app] = {
      appVersion: record.version,
      patches: {
        repo: record.patches.repo,
        tag: record.patches.tag,
        sha256: record.patches.sha256,
      },
      morphe: record.morphe,
      inputKey: record.inputKey,
      asset: apk.asset,
      apkSha256: apk.sha256,
      builtAt: record.finishedAt,
    }
    published.push(apk.app)
    yield* Effect.log(
      `${apk.app}: published ${apk.asset}${old.length ? `, removed ${old.map((a) => a.name).join(", ")}` : ""}`,
    )
  }

  const next: Manifest = { manifestVersion: 1, apps }
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "release-" })
  const manifestFile = path.join(dir, MANIFEST_ASSET)
  yield* fs.writeFileString(manifestFile, `${JSON.stringify(next, null, 2)}\n`)
  yield* gh(["release", "upload", tag, "-R", repo, "--clobber", manifestFile])
  const notesFile = path.join(dir, "notes.md")
  yield* fs.writeFileString(notesFile, releaseNotes(config, next, signed.certificateSha256))
  yield* gh(["release", "edit", tag, "-R", repo, "--notes-file", notesFile])
  return published
}, Effect.scoped)
