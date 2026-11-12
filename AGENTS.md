# auto-apk

A scheduled GitHub Actions pipeline. For each app listed in `auto-apk.json` it finds the
latest Morphe patch release, asks Morphe which app version those patches support,
downloads a genuine stock APK of that version, patches it, signs it with one key, and
publishes it as that app's own release; `latest` is the index. Which apps are built is
configuration, not code. `PLAN.md` is the design and the record of decisions.

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
- `scripts/create-signing-key.sh`: creates the signing key and stores it in Infisical;
  run once by the owner. Never prints a secret.

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

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Agent skills

Vendored in `.agents/skills/` (OpenCode, which Pullfrog runs) and `.claude/skills/`
(Claude Code), pinned by hash in `skills-lock.json`. Use them when the task matches:

- `github-actions-hardening`: before writing or changing any workflow.
- `github-actions-efficiency`: caching, concurrency, path filters, runtime.
- `varlock`: `.env.schema` and anything touching secrets.

Update with `npx skills update`, review the diff like any dependency, never hand-edit.

## Lint notes

The `effecttsgo/unstable-api-usage` rule is off: `effect/cli`, `FileSystem` and
`@effect/platform-bun` are marked unstable in Effect 4.1 and are used on purpose.

Conventional commit titles. Every change goes through a pull request; `ci` must pass.

## Pull requests and review

- Security-relevant pull requests wait for the Pullfrog review before merging:
  anything touching `src/Verify.ts`, `src/Sign.ts`, `src/Sources.ts`,
  `src/Morphe.ts`, `src/Release.ts`, `.github/workflows/`, `.env.schema`,
  `scripts/create-signing-key.sh`, or permissions and secrets.
- Everything else merges as soon as `ci` is green. Its review lands afterwards;
  fix the findings in a follow-up pull request.
- Renovate pull requests merge on green `ci` whether or not they touch a workflow:
  Pullfrog does not review PRs opened by bots, so the review gate cannot apply.
  `actionlint` and `zizmor` in `ci` are the check for those.
- Re-review is off. After addressing findings, push the fixes as one batch and
  comment `@pullfrog review` once.
- Batch fixes into one push instead of several small commits.

Keep `README.md` minimal: what it is, the warning, how to install, and links. Details
belong in `AGENTS.md` (for working on the repo) and `PLAN.md` (design and decisions).
The app table in it is generated from `auto-apk.json`: after changing apps, run
`bun src/main.ts readme` (a test fails while it is stale).
