/**
 * Publish signed APKs. Each app build gets its own release, tagged like its file
 * (`youtube-21.30.216-p2.2.0-arm64-v8a`), because Obtainium takes an app's version
 * from its release tag and filters releases by title: a new tag is how a phone
 * learns there is an update, for that app only. Only the latest build per app is
 * kept.
 *
 * The index release (`publish.tag`, "latest") holds manifest.json and a table
 * linking every app's current release; it stays GitHub's "Latest release".
 *
 * Order per run, so a failure never leaves the index pointing at something gone:
 *   1. create (or update) each app's new release
 *   2. rewrite manifest.json and the index notes
 *   3. delete each app's previous release and its tag
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

/** An app release's tag (and title): the asset name without `.apk`. */
export const releaseTag = (asset: string) => asset.replace(/\.apk$/u, "")

const releaseUrl = (repo: string, tag: string) => `https://github.com/${repo}/releases/tag/${tag}`

export const releaseNotes = (config: Config, manifest: Manifest, certificate: string): string => {
  const ids = Object.keys(config.apps).filter((id) => manifest.apps[id])
  const rows = ids.map((id) => {
    const e = manifest.apps[id]!
    const name = config.apps[id]?.name ?? id
    const file = e.release
      ? `[\`${e.asset}\`](${releaseUrl(config.publish.repo, e.release)})`
      : `\`${e.asset}\``
    return `| ${name} | ${e.appVersion} | [${e.patches.repo}](https://github.com/${e.patches.repo}) ${e.patches.tag} | ${file} | ${e.builtAt.slice(0, 10)} |`
  })
  return [
    "Unofficial, Morphe-patched builds. Each app has its own release holding its latest build; this one is the index.",
    "",
    `Signing certificate SHA-256: \`${certificate}\``,
    "",
    "| App | Version | Patches | File | Built |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Provenance: \`gh attestation verify <file>.apk --repo ${config.publish.repo}\``,
  ].join("\n")
}

/** Notes on one app's release. */
export const appReleaseNotes = (
  config: Config,
  record: BuildRecord,
  certificate: string,
  apkSha256: string,
): string =>
  [
    `**${config.apps[record.app]?.name ?? record.app}** ${record.version}, patched with [${record.patches.repo}](https://github.com/${record.patches.repo}) ${record.patches.tag} and Morphe ${record.morphe}. Unofficial build.`,
    "",
    `- APK SHA-256: \`${apkSha256}\``,
    `- Signing certificate SHA-256: \`${certificate}\``,
    `- Provenance: \`gh attestation verify <file>.apk --repo ${config.publish.repo}\``,
  ].join("\n")

export const publish = Effect.fn("publish")(function* (
  config: Config,
  records: ReadonlyArray<BuildRecord>,
  signed: SigningResult,
  signedDir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { repo, tag: indexTag } = config.publish

  // Nothing signed: leave every release, the manifest and the notes as they are.
  if (signed.apks.length === 0) return []

  if (Option.isNone(yield* GitHub.findRelease(repo, indexTag))) {
    yield* gh([
      "release",
      "create",
      indexTag,
      "-R",
      repo,
      "--title",
      "Latest builds",
      "--notes",
      "Preparing…",
      "--latest",
    ])
  }
  const manifest = yield* readManifest(repo, indexTag)
  const apps = { ...manifest.apps }
  const published: Array<string> = []
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "release-" })

  // 1. Each app's new release. Nothing is removed yet.
  for (const apk of signed.apks) {
    const record = records.find((r) => r.app === apk.app)
    if (!record?.version || !record.inputKey) continue
    const tag = releaseTag(apk.asset)
    const file = path.join(signedDir, apk.asset)
    const notesFile = path.join(dir, `${tag}.md`)
    yield* fs.writeFileString(
      notesFile,
      appReleaseNotes(config, record, signed.certificateSha256, apk.sha256),
    )
    if (Option.isSome(yield* GitHub.findRelease(repo, tag))) {
      // Same inputs built again (a forced run): replace the file in place.
      yield* gh(["release", "upload", tag, "-R", repo, "--clobber", file])
      yield* gh(["release", "edit", tag, "-R", repo, "--notes-file", notesFile])
    } else {
      yield* gh([
        "release",
        "create",
        tag,
        "-R",
        repo,
        "--title",
        tag,
        "--notes-file",
        notesFile,
        "--latest=false",
        file,
      ])
    }
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
      release: tag,
      apkSha256: apk.sha256,
      builtAt: record.finishedAt,
    }
    published.push(apk.app)
    yield* Effect.log(`${apk.app}: released ${tag}`)
  }
  if (published.length === 0) return []

  // 2. Point the index at the new releases, and keep it GitHub's "Latest release".
  const next: Manifest = { manifestVersion: 1, apps }
  const manifestFile = path.join(dir, MANIFEST_ASSET)
  yield* fs.writeFileString(manifestFile, `${JSON.stringify(next, null, 2)}\n`)
  yield* gh(["release", "upload", indexTag, "-R", repo, "--clobber", manifestFile])
  const indexNotes = path.join(dir, "index.md")
  yield* fs.writeFileString(indexNotes, releaseNotes(config, next, signed.certificateSha256))
  yield* gh(["release", "edit", indexTag, "-R", repo, "--notes-file", indexNotes, "--latest"])

  // 3. Only now remove what the previous manifest named: the app's previous release,
  //    or, for entries from before per-app releases, its file in the index release.
  for (const app of published) {
    const previous = manifest.apps[app]
    const current = apps[app]
    if (!previous || !current) continue
    if (previous.release && previous.release !== current.release) {
      yield* gh(["release", "delete", previous.release, "-R", repo, "--cleanup-tag", "--yes"])
      yield* Effect.log(`${app}: removed release ${previous.release}`)
    } else if (!previous.release) {
      yield* gh(["release", "delete-asset", indexTag, previous.asset, "-R", repo, "--yes"]).pipe(
        Effect.catchTag("CommandFailed", () => Effect.void), // already gone
      )
      yield* Effect.log(`${app}: removed ${previous.asset} from ${indexTag}`)
    }
  }
  return published
}, Effect.scoped)
