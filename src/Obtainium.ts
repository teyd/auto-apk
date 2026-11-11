/**
 * Obtainium import entries and links, generated from the config.
 *
 * Each app has its own release per build, tagged `<app id>-<version>-p<patches>-<arch>`.
 * Obtainium takes an app's version from the release tag, so it is told to filter
 * release titles by `^<app id>-` and to look past releases of other apps
 * (`fallbackToOlderReleases`, which Obtainium only honours when exactly true).
 * The `id` is the package name, so Obtainium also sees what is already installed.
 */
import type { Config, ResolvedApp } from "./Config.ts"

export interface ObtainiumEntry {
  readonly id: string
  readonly url: string
  readonly author: string
  readonly name: string
  /** A JSON string, as Obtainium's import format expects. */
  readonly additionalSettings: string
}

export const appEntry = (config: Config, app: ResolvedApp): ObtainiumEntry => ({
  id: app.package,
  url: `https://github.com/${config.publish.repo}`,
  author: config.publish.repo.split("/")[0] ?? "",
  name: app.name,
  additionalSettings: JSON.stringify({
    filterReleaseTitlesByRegEx: `^${app.id}-`,
    fallbackToOlderReleases: true,
  }),
})

/** MicroG-RE, which Morphe's YouTube needs; its release holds several variants. */
export const microgEntry = (arch: string): ObtainiumEntry => ({
  id: "app.revanced.android.gms",
  url: "https://github.com/MorpheApp/MicroG-RE",
  author: "MorpheApp",
  name: "MicroG-RE",
  additionalSettings: JSON.stringify({
    apkFilterRegEx: `-icon-${arch.replaceAll(".", "\\.")}\\.apk$`,
  }),
})

/** A link that opens Obtainium's import for one app, or offers to install Obtainium. */
export const addLink = (entry: ObtainiumEntry): string =>
  `https://apps.obtainium.imranr.dev/redirect?r=${encodeURIComponent(
    `obtainium://app/${encodeURIComponent(JSON.stringify(entry))}`,
  )}`

/** One link that imports several apps at once (Obtainium itself, no redirect page). */
export const addAllLink = (entries: ReadonlyArray<ObtainiumEntry>): string =>
  `obtainium://apps/${encodeURIComponent(JSON.stringify(entries))}`
