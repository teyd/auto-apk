#!/usr/bin/env bun
/**
 * auto-apk command line. Each workflow job runs one subcommand; the same
 * subcommands run locally.
 *
 *   check    validate auto-apk.json
 *   schema   write schema/auto-apk.schema.json (--check: fail if it is stale)
 *   plan     decide which apps to build (compares inputs with manifest.json)
 *   build    download, verify and patch one app (or all); writes out/<app>/
 *   sign     sign built APKs with the release key (run inside `varlock run`)
 *   release  upload signed APKs, replace old ones, write manifest.json and notes
 *   report   open, update or close one issue per app from the build records
 *   readme   regenerate the app table in README.md from auto-apk.json
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config as EnvConfig, Console, Data, Effect, FileSystem, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { buildApp } from "./Build.ts"
import { ConfigError, jsonSchema, loadConfig, resolveApps } from "./Config.ts"
import { readManifest } from "./Manifest.ts"
import { planApps } from "./Plan.ts"
import { renderReadme } from "./Readme.ts"
import { publish } from "./Release.ts"
import { findRecords, markUnpublished, readRecords, report, summary } from "./Report.ts"
import { SigningResult, assetName, signAll } from "./Sign.ts"

const Published = Schema.fromJsonString(Schema.Struct({ apps: Schema.Array(Schema.String) }))

/** Append to a file GitHub Actions reads ($GITHUB_OUTPUT, $GITHUB_STEP_SUMMARY), when set. */
const appendToEnvFile = (name: string, text: string) =>
  Effect.gen(function* () {
    const file = yield* EnvConfig.option(EnvConfig.String(name))
    if (Option.isNone(file)) return
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(file.value, text.endsWith("\n") ? text : `${text}\n`, { flag: "a" })
  })

const list = (s: string) =>
  s
    .replace(/[[\]"]/gu, " ") // also accept the JSON array plan writes
    .split(/[\s,]+/u)
    .map((x) => x.trim())
    .filter(Boolean)

const SCHEMA_PATH = "schema/auto-apk.schema.json"

const configFlag = Flag.String("config").pipe(
  Flag.withDescription("Path to the config file."),
  Flag.withDefault("auto-apk.json"),
)

class SchemaStale extends Data.TaggedError("SchemaStale")<{ readonly path: string }> {
  override get message() {
    return `${this.path} is out of date. Run: bun run schema`
  }
}

const check = Command.make("check", { config: configFlag }, ({ config }) =>
  Effect.gen(function* () {
    const cfg = yield* loadConfig(config)
    const apps = resolveApps(cfg)
    yield* Console.log(
      `${config} is valid: ${apps.length} apps, ${apps.filter((a) => a.enabled).length} enabled`,
    )
    for (const a of apps) {
      yield* Console.log(
        `  ${a.enabled ? "+" : "-"} ${a.id.padEnd(10)} ${a.package.padEnd(38)} ${a.patches.repo.padEnd(36)} ${a.sources.map((s) => s.name).join(" > ")}`,
      )
    }
  }),
).pipe(Command.withDescription("Validate auto-apk.json against the schema and its extra rules."))

const schema = Command.make(
  "schema",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Do not write; fail if the committed schema differs from the generated one.",
      ),
      Flag.withDefault(false),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const text = `${JSON.stringify(jsonSchema(), null, 2)}\n`
      if (flags.check) {
        const current = yield* fs.readFileString(SCHEMA_PATH).pipe(Effect.orElseSucceed(() => ""))
        if (current !== text) return yield* new SchemaStale({ path: SCHEMA_PATH })
        return yield* Console.log(`${SCHEMA_PATH} is current`)
      }
      yield* fs.makeDirectory("schema", { recursive: true })
      yield* fs.writeFileString(SCHEMA_PATH, text)
      return yield* Console.log(`wrote ${SCHEMA_PATH}`)
    }),
).pipe(Command.withDescription("Generate the JSON Schema for auto-apk.json from src/Config.ts."))

class SomeBuildsFailed extends Data.TaggedError("SomeBuildsFailed")<{
  readonly failed: ReadonlyArray<string>
}> {
  override get message() {
    return `failed: ${this.failed.join(", ")}`
  }
}

const build = Command.make(
  "build",
  {
    config: configFlag,
    app: Flag.String("app").pipe(
      Flag.withDescription('App id from auto-apk.json, or "all" for every enabled app.'),
    ),
    version: Flag.String("version").pipe(
      Flag.withDescription("Build this exact version instead of Morphe's choice."),
      Flag.optional,
    ),
    work: Flag.String("work").pipe(
      Flag.withDescription("Cache and download directory."),
      Flag.withDefault("work"),
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("Where build.json and the APK go."),
      Flag.withDefault("out"),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const cfg = yield* loadConfig(flags.config)
      const apps = resolveApps(cfg)
      const selected =
        flags.app === "all" ? apps.filter((a) => a.enabled) : apps.filter((a) => a.id === flags.app)
      if (selected.length === 0) {
        return yield* new ConfigError({
          path: flags.config,
          problems: [`no app "${flags.app}" (apps: ${apps.map((a) => a.id).join(", ")})`],
        })
      }
      const version = flags.version._tag === "Some" ? flags.version.value : undefined
      const failed: Array<string> = []
      for (const app of selected) {
        const result = yield* buildApp(cfg, app, {
          workDir: flags.work,
          outDir: flags.out,
          version,
        }).pipe(Effect.result)
        if (result._tag === "Success") {
          yield* Console.log(
            `${app.id}: built ${result.success.version} -> ${result.success.apk?.file}`,
          )
        } else {
          failed.push(app.id)
          yield* Console.error(result.failure.message)
        }
      }
      return failed.length > 0 ? yield* new SomeBuildsFailed({ failed }) : undefined
    }),
).pipe(
  Command.withDescription("Download, verify and patch apps. Unsigned output; holds no secrets."),
)

const plan = Command.make(
  "plan",
  {
    config: configFlag,
    force: Flag.String("force").pipe(
      Flag.withDescription(
        'Build these apps even if unchanged: "all", or ids separated by commas.',
      ),
      Flag.withDefault(""),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const cfg = yield* loadConfig(flags.config)
      const manifest = yield* readManifest(cfg.publish.repo, cfg.publish.tag)
      const force = flags.force.trim() === "all" ? ("all" as const) : list(flags.force)
      const planned = yield* planApps(cfg, resolveApps(cfg), manifest, { force })
      const toBuild = planned.filter((p) => p.build).map((p) => p.id)
      const table = [
        "| App | Build | Why | Patches |",
        "|---|---|---|---|",
        ...planned.map(
          (p) => `| ${p.id} | ${p.build ? "yes" : "no"} | ${p.reason} | ${p.patchesTag} |`,
        ),
      ].join("\n")
      yield* Console.log(table)
      yield* appendToEnvFile(
        "GITHUB_OUTPUT",
        `apps=${JSON.stringify(toBuild)}\nany=${toBuild.length > 0}`,
      )
      yield* appendToEnvFile("GITHUB_STEP_SUMMARY", `## Plan\n\n${table}`)
    }),
).pipe(
  Command.withDescription("Decide which apps to build. GitHub API only; no Java, no downloads."),
)

const reportCmd = Command.make(
  "report",
  {
    config: configFlag,
    records: Flag.String("records").pipe(
      Flag.withDescription("Directory holding <app>/build.json."),
    ),
    apps: Flag.String("apps").pipe(
      Flag.withDescription("App ids the build was asked for, separated by commas."),
    ),
    published: Flag.String("published").pipe(
      Flag.withDescription(
        "published.json from the release step; a built app missing from it counts as failed.",
      ),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const cfg = yield* loadConfig(flags.config)
      const repo = Option.getOrElse(
        yield* EnvConfig.option(EnvConfig.String("GITHUB_REPOSITORY")),
        () => cfg.publish.repo,
      )
      const server = Option.getOrElse(
        yield* EnvConfig.option(EnvConfig.String("GITHUB_SERVER_URL")),
        () => "https://github.com",
      )
      const runId = yield* EnvConfig.option(EnvConfig.String("GITHUB_RUN_ID"))
      const runUrl = Option.isSome(runId)
        ? `${server}/${repo}/actions/runs/${runId.value}`
        : `${server}/${repo}/actions`
      const built = yield* readRecords(flags.records, list(flags.apps))
      // With --published, a built app that is not in the release is a failure too.
      // A missing or unreadable file means nothing was published.
      let records: ReadonlyArray<(typeof built)[number]> = built
      if (Option.isSome(flags.published)) {
        const fs = yield* FileSystem.FileSystem
        const published = yield* fs.readFileString(flags.published.value).pipe(
          Effect.flatMap(Schema.decodeEffect(Published)),
          Effect.map((p) => p.apps),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        )
        records = markUnpublished(built, new Set(published))
      }
      // The publish job's own result decides whether one "Publish failing" issue is
      // opened instead of one per affected app; the rerun that works closes it.
      const publishResult = Option.getOrUndefined(
        yield* EnvConfig.option(EnvConfig.String("PUBLISH_RESULT")),
      )
      const actions = yield* report(repo, records, runUrl, { publishResult })
      const text = summary(records, actions)
      yield* Console.log(text)
      yield* appendToEnvFile("GITHUB_STEP_SUMMARY", `## Builds\n\n${text}`)
    }),
).pipe(Command.withDescription("Open, update or close one issue per app from its build record."))

const sign = Command.make(
  "sign",
  {
    config: configFlag,
    records: Flag.String("records").pipe(
      Flag.withDescription("Directory holding the build records."),
    ),
    unsigned: Flag.String("unsigned").pipe(
      Flag.withDescription("Directory holding <app>-unsigned.apk files, at any depth."),
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("Where the signed APKs and signing.json go."),
      Flag.withDefault("signed"),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const cfg = yield* loadConfig(flags.config)
      const fs = yield* FileSystem.FileSystem
      const apps = resolveApps(cfg)
      const records = [...(yield* findRecords(flags.records)).values()].filter(
        (r) => r.status === "built",
      )
      // No unsigned/ at all when every leg failed: nothing to sign, not an error.
      const files = yield* fs
        .readDirectory(flags.unsigned, { recursive: true })
        .pipe(Effect.orElseSucceed((): Array<string> => []))
      const items: Array<Parameters<typeof signAll>[0][number]> = []
      for (const record of records) {
        const file = files.find((f) => f.endsWith(`${record.app}-unsigned.apk`))
        const app = apps.find((a) => a.id === record.app)
        if (!file || !app) {
          yield* Console.error(`${record.app}: built, but its unsigned APK is missing`)
          continue
        }
        items.push({
          record,
          unsigned: `${flags.unsigned}/${file}`,
          asset: assetName(cfg.publish.asset, record, app.arch),
        })
      }
      const result = yield* signAll(items, flags.out)
      yield* Console.log(`signed: ${result.apks.map((a) => a.asset).join(", ") || "nothing"}`)
      yield* Console.log(`certificate SHA-256: ${result.certificateSha256}`)
    }),
).pipe(
  Command.withDescription(
    "Sign built APKs. Reads the keystore from the environment (varlock run).",
  ),
)

const releaseCmd = Command.make(
  "release",
  {
    config: configFlag,
    records: Flag.String("records").pipe(
      Flag.withDescription("Directory holding the build records."),
    ),
    signed: Flag.String("signed").pipe(
      Flag.withDescription("Output directory of sign."),
      Flag.withDefault("signed"),
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("Where to write published.json."),
      Flag.withDefault("published.json"),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const cfg = yield* loadConfig(flags.config)
      const fs = yield* FileSystem.FileSystem
      const records = [...(yield* findRecords(flags.records)).values()]
      const signing = yield* fs
        .readFileString(`${flags.signed}/signing.json`)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SigningResult))))
      const published = yield* publish(cfg, records, signing, flags.signed)
      yield* fs.writeFileString(flags.out, `${JSON.stringify({ apps: published })}\n`)
      yield* Console.log(`published: ${published.join(", ") || "nothing"}`)
    }),
).pipe(
  Command.withDescription("Upload signed APKs to the release; update manifest.json and the notes."),
)

const readme = Command.make("readme", { config: configFlag }, ({ config }) =>
  Effect.gen(function* () {
    const cfg = yield* loadConfig(config)
    const fs = yield* FileSystem.FileSystem
    const current = yield* fs.readFileString("README.md")
    yield* fs.writeFileString("README.md", renderReadme(current, cfg))
    yield* Console.log("README.md app table updated")
  }),
).pipe(Command.withDescription("Regenerate the app table in README.md from auto-apk.json."))

const cli = Command.make("auto-apk").pipe(
  Command.withDescription("Automated Morphe patch builds."),
  Command.withSubcommands([check, schema, plan, build, sign, releaseCmd, reportCmd, readme]),
)

/** Expected failures print their message and exit 1; anything else keeps its full report. */
const exit1 = (e: { readonly message: string }) =>
  Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))

const program = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.catchTags({ ConfigError: exit1, SchemaStale: exit1, SomeBuildsFailed: exit1 }),
)

program.pipe(Effect.provide([BunServices.layer, FetchHttpClient.layer]), BunRuntime.runMain)
