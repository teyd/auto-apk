/**
 * Decide which apps to build. Cheap on purpose: GitHub API calls only, no Java.
 *
 * An app is rebuilt when its input key differs from the one in manifest.json. The
 * key covers everything that decides the output: the patch release and its asset,
 * the Morphe jar, and the app's version, arch and package settings. The same patches
 * and the same Morphe give the same target version, so Morphe need not run here.
 */
import { Effect } from "effect"
import type { Config, ResolvedApp } from "./Config.ts"
import * as GitHub from "./GitHub.ts"
import type { Manifest } from "./Manifest.ts"

export interface PlannedApp {
  readonly id: string
  readonly build: boolean
  readonly reason: string
  readonly patchesTag: string
  readonly inputKey: string
}

export const inputKey = (
  config: Config,
  app: ResolvedApp,
  patches: { readonly tag: string; readonly asset: GitHub.Asset },
): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(
    JSON.stringify({
      patches: [
        app.patches.repo,
        patches.tag,
        patches.asset.name,
        patches.asset.digest ?? patches.asset.size,
      ],
      morphe: config.tools.morphe.sha256,
      app: [app.package, app.signature, app.version, app.arch, app.experimental],
    }),
  )
  return hasher.digest("hex")
}

export const planApps = Effect.fn("planApps")(function* (
  config: Config,
  apps: ReadonlyArray<ResolvedApp>,
  manifest: Manifest,
  options: { readonly force?: ReadonlyArray<string> | "all" | undefined } = {},
) {
  // Apps that share a patch repo share one lookup.
  const releases = new Map<string, Effect.Success<ReturnType<typeof GitHub.latestRelease>>>()
  const planned: Array<PlannedApp> = []
  for (const app of apps.filter((a) => a.enabled)) {
    const cacheKey = `${app.patches.repo}#${app.patches.channel}`
    const release =
      releases.get(cacheKey) ?? (yield* GitHub.latestRelease(app.patches.repo, app.patches.channel))
    releases.set(cacheKey, release)
    const asset = yield* GitHub.pickAsset(release, app.patches.asset)
    const key = inputKey(config, app, { tag: release.tag_name, asset })
    const previous = manifest.apps[app.id]
    const forced = options.force === "all" || (options.force ?? []).includes(app.id)
    const reason = forced
      ? "forced"
      : !previous
        ? "never built"
        : previous.inputKey !== key
          ? previous.patches.tag !== release.tag_name
            ? `patches ${previous.patches.tag} -> ${release.tag_name}`
            : "inputs changed"
          : "up to date"
    planned.push({
      id: app.id,
      build: reason !== "up to date",
      reason,
      patchesTag: release.tag_name,
      inputKey: key,
    })
  }
  return planned
})
