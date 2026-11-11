#!/usr/bin/env bun
/**
 * auto-apk command line. Each workflow job runs one subcommand; the same
 * subcommands run locally.
 *
 *   check    validate auto-apk.json
 *   schema   write schema/auto-apk.schema.json (--check: fail if it is stale)
 *
 * plan, build and publish arrive in Phases 2 and 3.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Data, Effect, FileSystem } from "effect"
import { Command, Flag } from "effect/cli"
import { jsonSchema, loadConfig, resolveApps } from "./Config.ts"

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

const cli = Command.make("auto-apk").pipe(
  Command.withDescription("Automated Morphe patch builds."),
  Command.withSubcommands([check, schema]),
)

/** Expected failures print their message and exit 1; anything else keeps its full report. */
const program = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.catchTags({
    ConfigError: (e) =>
      Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
    SchemaStale: (e) =>
      Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
  }),
)

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
