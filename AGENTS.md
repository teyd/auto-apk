# auto-apk

A scheduled GitHub Actions pipeline. For each of 8 Android apps it finds the latest
Morphe patch release, asks Morphe which app version those patches support, downloads a
genuine stock APK of that version, patches it, signs it with one key, and replaces that
app's APK in one rolling public release (`latest`). `PLAN.md` is the design and the
record of decisions.

## Layout

- `auto-apk.json`: the only config. Its JSON Schema (`schema/`) is generated from
  `src/Config.ts`; run `bun run schema` after changing the schema.
- `src/main.ts`: CLI. Each workflow job runs one subcommand (`check`, `schema`; `plan`,
  `build`, `publish` come later).
- `src/Morphe.ts` (to come) is the only file that runs the Morphe jar.
- `.env.schema`: signing secrets, declared for varlock; values live in Infisical.
  `src/env.generated.ts` is generated from it (`bun run env:codegen`; the
  Infisical IDs are placeholders there because code generation needs none).
- `scripts/setup-repo.sh`: GitHub and Pullfrog settings, applied by the owner.

## Rules that must not be weakened

- Only the `publish` job (environment `release`) can read signing secrets. `build`
  handles untrusted downloads and third-party patch bundles and holds no secrets and
  no `id-token`.
- Every downloaded APK and split must carry the app's pinned certificate among its
  signers.
- A build fails unless Morphe applied exactly as many patches as `list-versions`
  reported. Morphe reports success with 0 patches on an unsupported version.
- Actions are pinned to full commit SHAs. No `pull_request_target`.

## Stack and commands

Bun 1.4, TypeScript 7 through `@effect/tsgo`, Effect 4.1 (Schema, `effect/cli`,
`@effect/platform-bun`), oxlint with the Effect `strict` preset, oxfmt.

    bun install --frozen-lockfile
    bun run typecheck     # effect-tsgo tsc --noEmit
    bun run lint          # oxlint, Effect rules included
    bun run fmt           # oxfmt (fmt:check in CI)
    bun test
    bun src/main.ts check # validate auto-apk.json

The `effecttsgo/unstable-api-usage` rule is off: `effect/cli`, `FileSystem` and
`@effect/platform-bun` are marked unstable in Effect 4.1 and are used on purpose.

Conventional commit titles. Every change goes through a pull request; `ci` must pass.
