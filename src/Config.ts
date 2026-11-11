/**
 * The shape of `auto-apk.json`, and the rules that make one valid.
 *
 * The JSON Schema in `schema/auto-apk.schema.json` is generated from this file
 * (`bun run schema`), so editors and this code always agree.
 */
import { Data, Effect, FileSystem, Schema, SchemaIssue } from "effect"

// ---------------------------------------------------------------- building blocks

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).annotate({
  description: "SHA-256 as 64 lowercase hex characters.",
})

const GitHubRepo = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u),
).annotate({ description: "A GitHub repository as owner/name." })

const PackageName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/u),
).annotate({ description: "Android package name, for example com.google.android.youtube." })

const RegexString = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "A JavaScript regular expression, matched against release asset names.",
})

const NonEmpty = Schema.String.check(Schema.isMinLength(1))

export const SourceName = Schema.Literals(["apkmirror", "apkpure", "archive"]).annotate({
  description:
    "Where a stock APK can come from. apkmirror: APKMirror through FlareSolverr. apkpure: APKPure's app API. archive: an archive.org directory of APKs.",
})
export type SourceName = typeof SourceName.Type

export const Arch = Schema.Literals(["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]).annotate({
  description: "The one CPU architecture kept in the patched APK (Morphe --striplibs).",
})

const Version = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    'App version to build. "auto" asks Morphe which version the current patches support best. Any other value holds that exact version.',
})

const Channel = Schema.Literals(["stable", "prerelease"]).annotate({
  description:
    "Which patch releases to follow: the latest stable release, or the latest pre-release.",
})

// ---------------------------------------------------------------- sections

const Morphe = Schema.Struct({
  repo: GitHubRepo.annotate({
    description: "GitHub repository that publishes the Morphe CLI jar.",
  }),
  version: NonEmpty.annotate({ description: "Release tag of the CLI, without a leading v." }),
  asset: RegexString.annotate({
    description: "Regex that picks the jar among the release assets.",
  }),
  sha256: Sha256.annotate({
    description: "SHA-256 of the jar. A download that does not match is rejected.",
  }),
  java: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 17, maximum: 99 }),
  ).annotate({
    description: "Java major version the CLI needs.",
  }),
  jvmArgs: Schema.Array(Schema.String).annotate({
    description: "Extra JVM arguments for patching, such as -Xmx4g.",
  }),
}).annotate({
  description: "The Morphe CLI. Everything Morphe-specific outside src/Morphe.ts lives here.",
})

const FlareSolverr = Schema.Struct({
  image: Schema.String.check(Schema.isPattern(/^[^\s@]+@sha256:[0-9a-f]{64}$/u)).annotate({
    description: "Container image, pinned by digest (name:tag@sha256:...).",
  }),
}).annotate({ description: "FlareSolverr, which gets APKMirror pages past Cloudflare." })

const Tools = Schema.Struct({
  morphe: Morphe,
  flaresolverr: FlareSolverr,
}).annotate({ description: "Exact versions of the tools that run. Renovate keeps these current." })

const PatchesDefaults = Schema.Struct({
  asset: RegexString.annotate({
    description: "Regex that picks the patch bundle among the release assets.",
  }),
  channel: Channel,
})

const Defaults = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "Whether an app is built." }),
  arch: Arch,
  experimental: Schema.Boolean.annotate({
    description:
      "Let Morphe offer versions its patches mark experimental (--include-experimental).",
  }),
  version: Version,
  sources: Schema.NonEmptyArray(SourceName).annotate({
    description: "Order in which sources are tried. A source an app does not list is skipped.",
  }),
  patches: PatchesDefaults,
}).annotate({ description: "What applies to every app unless the app repeats the key." })

const Publish = Schema.Struct({
  repo: GitHubRepo.annotate({ description: "Repository whose release receives the APKs." }),
  tag: NonEmpty.annotate({ description: "Tag of the one rolling release." }),
  asset: Schema.String.check(
    Schema.isPattern(/\{app\}/u),
    Schema.isPattern(/\{appVersion\}/u),
  ).annotate({
    description:
      "File name of each APK. Placeholders: {app}, {appVersion}, {patchesVersion}, {arch}. {app} and {appVersion} are required.",
  }),
}).annotate({ description: "Where results go and how files are named." })

const AppPatches = Schema.Struct({
  repo: GitHubRepo.annotate({ description: "GitHub repository that publishes the patch bundle." }),
  asset: Schema.optionalKey(RegexString),
  channel: Schema.optionalKey(Channel),
}).annotate({
  description: "The app's patch bundle. asset and channel default to defaults.patches.",
})

const ApkMirrorLink = Schema.Struct({
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/www\.apkmirror\.com\/apk\/[^/]+\/[^/]+\/$/u),
  ).annotate({
    description: "The app's APKMirror page, https://www.apkmirror.com/apk/<developer>/<app>/",
  }),
})

const ApkPureLink = Schema.Struct({}).annotate({
  description: "APKPure needs no link; the package name is enough. Write {} to use it.",
})

const ArchiveLink = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https:\/\/archive\.org\/download\/\S+$/u)).annotate({
    description: "An archive.org directory listing of this app's APKs.",
  }),
})

const AppSources = Schema.Struct({
  apkmirror: Schema.optionalKey(ApkMirrorLink),
  apkpure: Schema.optionalKey(ApkPureLink),
  archive: Schema.optionalKey(ArchiveLink),
}).annotate({
  description: "Where this app can be downloaded. The order comes from defaults.sources.",
})

const App = Schema.Struct({
  name: NonEmpty.annotate({ description: "Display name." }),
  package: PackageName,
  patches: AppPatches,
  signature: Sha256.annotate({
    description:
      "SHA-256 of the publisher's original signing certificate. Every downloaded APK and split must carry it among its signers.",
  }),
  sources: AppSources,
  enabled: Schema.optionalKey(Schema.Boolean),
  arch: Schema.optionalKey(Arch),
  experimental: Schema.optionalKey(Schema.Boolean),
  version: Schema.optionalKey(Version),
}).annotate({ description: "One app. Any key from defaults may be repeated here to override it." })

const AppId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)).annotate({
  description: "Short lowercase id, used in asset names and issue titles.",
})

export const Config = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  configVersion: Schema.Literal(1).annotate({ description: "Format version of this file." }),
  tools: Tools,
  defaults: Defaults,
  publish: Publish,
  apps: Schema.Record(AppId, App),
}).annotate({
  title: "auto-apk configuration",
  description: "Which apps auto-apk builds, and how.",
})

export type Config = typeof Config.Type

// ---------------------------------------------------------------- resolved view

/** An app with every default applied: what the rest of the code works with. */
export interface ResolvedApp {
  readonly id: string
  readonly name: string
  readonly package: string
  readonly signature: string
  readonly enabled: boolean
  readonly arch: typeof Arch.Type
  readonly experimental: boolean
  readonly version: string
  readonly patches: {
    readonly repo: string
    readonly asset: string
    readonly channel: typeof Channel.Type
  }
  /** Sources to try, in order, each with its link. */
  readonly sources: ReadonlyArray<ResolvedSource>
}

export type ResolvedSource =
  | { readonly name: "apkmirror"; readonly url: string }
  | { readonly name: "apkpure" }
  | { readonly name: "archive"; readonly url: string }

export const resolveApp = (
  config: Config,
  id: string,
  app: Config["apps"][string],
): ResolvedApp => {
  const d = config.defaults
  const sources: Array<ResolvedSource> = []
  for (const name of d.sources) {
    if (name === "apkmirror" && app.sources.apkmirror)
      sources.push({ name, url: app.sources.apkmirror.url })
    if (name === "apkpure" && app.sources.apkpure) sources.push({ name })
    if (name === "archive" && app.sources.archive)
      sources.push({ name, url: app.sources.archive.url })
  }
  return {
    id,
    name: app.name,
    package: app.package,
    signature: app.signature,
    enabled: app.enabled ?? d.enabled,
    arch: app.arch ?? d.arch,
    experimental: app.experimental ?? d.experimental,
    version: app.version ?? d.version,
    patches: {
      repo: app.patches.repo,
      asset: app.patches.asset ?? d.patches.asset,
      channel: app.patches.channel ?? d.patches.channel,
    },
    sources,
  }
}

export const resolveApps = (config: Config): ReadonlyArray<ResolvedApp> =>
  Object.entries(config.apps).map(([id, app]) => resolveApp(config, id, app))

// ---------------------------------------------------------------- loading and checking

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly path: string
  readonly problems: ReadonlyArray<string>
}> {
  override get message() {
    return `${this.path} is not valid:\n${this.problems.map((p) => `  - ${p}`).join("\n")}`
  }
}

const parseOptions = { onExcessProperty: "error", errors: "all" } as const

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** One line per schema problem: `defaults.sources[1]: Expected ..., got "uptodown"`. */
const describeIssue = (issue: SchemaIssue.Issue): ReadonlyArray<string> =>
  formatIssues(issue).issues.map(({ message, path }) => {
    const where = (path ?? [])
      .map((k, i) => {
        const key = typeof k === "object" && k !== null && "key" in k ? k.key : k
        return typeof key === "number" ? `[${key}]` : `${i === 0 ? "" : "."}${String(key)}`
      })
      .join("")
    return where ? `${where}: ${message}` : message
  })

/** Rules the schema alone cannot express. Returns one message per problem. */
export const semanticProblems = (config: Config): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const regexes: Array<[string, string]> = [
    ["tools.morphe.asset", config.tools.morphe.asset],
    ["defaults.patches.asset", config.defaults.patches.asset],
  ]
  const packages = new Map<string, string>()
  const apps = resolveApps(config)

  if (new Set(config.defaults.sources).size !== config.defaults.sources.length) {
    problems.push("defaults.sources lists a source twice")
  }
  if (!apps.some((a) => a.enabled)) problems.push("no app is enabled")

  for (const app of apps) {
    const raw = config.apps[app.id]
    if (raw?.patches.asset) regexes.push([`apps.${app.id}.patches.asset`, raw.patches.asset])
    if (app.sources.length === 0) {
      problems.push(
        `apps.${app.id}: none of its sources is in defaults.sources (${config.defaults.sources.join(", ")})`,
      )
    }
    const other = packages.get(app.package)
    if (other)
      problems.push(`apps.${app.id} and apps.${other} have the same package ${app.package}`)
    packages.set(app.package, app.id)
  }

  for (const [where, source] of regexes) {
    try {
      RegExp(source)
    } catch (e) {
      problems.push(`${where}: not a valid regular expression (${String(e)})`)
    }
  }
  return problems
}

/** Decode and check a parsed JSON value. */
export const decodeConfig = (path: string, json: unknown) =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(
      Config,
      parseOptions,
    )(json).pipe(
      Effect.mapError((e) => new ConfigError({ path, problems: describeIssue(e.issue) })),
    )
    const problems = semanticProblems(config)
    if (problems.length > 0) return yield* new ConfigError({ path, problems })
    return config
  })

/** Read, parse, decode and check a config file. */
export const loadConfig = Effect.fn("loadConfig")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError((e) => new ConfigError({ path, problems: [`cannot read: ${e.message}`] })),
    )
  const json = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (e) => new ConfigError({ path, problems: [`not valid JSON: ${String(e)}`] }),
  })
  return yield* decodeConfig(path, json)
})

/** The JSON Schema document for auto-apk.json, as committed in schema/. */
export const jsonSchema = () => {
  const doc = Schema.toJsonSchemaDocument(Config, { onExcessProperty: "error" })
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/teyd/auto-apk/main/schema/auto-apk.schema.json",
    ...doc.schema,
    ...(Object.keys(doc.definitions).length > 0 ? { $defs: doc.definitions } : {}),
  }
}
