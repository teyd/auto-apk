/**
 * `manifest.json` in the index release (`publish.tag`): the public index of what
 * was built, and the pipeline's state. `plan` reads it to decide what to rebuild;
 * `release` writes it.
 */
import { Effect, Option, Schema } from "effect"
import * as GitHub from "./GitHub.ts"

export const ManifestEntry = Schema.Struct({
  appVersion: Schema.String,
  patches: Schema.Struct({ repo: Schema.String, tag: Schema.String, sha256: Schema.String }),
  morphe: Schema.String,
  /** Hash of everything that decides the output; see `inputKey` in Plan.ts. */
  inputKey: Schema.String,
  asset: Schema.String,
  /** Tag of the app's own release holding `asset`. Absent for entries written before per-app releases. */
  release: Schema.optionalKey(Schema.String),
  apkSha256: Schema.String,
  builtAt: Schema.String,
})
export type ManifestEntry = typeof ManifestEntry.Type

export const Manifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  apps: Schema.Record(Schema.String, ManifestEntry),
})
export type Manifest = typeof Manifest.Type

export const MANIFEST_ASSET = "manifest.json"

export const emptyManifest: Manifest = { manifestVersion: 1, apps: {} }

/** The manifest from the release, or an empty one when there is no release or no manifest yet. */
export const readManifest = Effect.fn("readManifest")(function* (repo: string, tag: string) {
  const release = yield* GitHub.findRelease(repo, tag)
  if (Option.isNone(release)) return emptyManifest
  const asset = release.value.assets.find((a) => a.name === MANIFEST_ASSET)
  if (!asset) return emptyManifest
  const text = yield* GitHub.fetchAssetText(asset)
  return yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(text)
})
