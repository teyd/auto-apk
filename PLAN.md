# auto-apk: automated Morphe patch builds for 8 apps

## Goal

A scheduled GitHub Actions pipeline that, for each app, detects a new patch release, asks Morphe which app version that release supports, downloads a genuine stock APK of exactly that version, patches it with the Morphe CLI, signs it with one persistent key, and replaces that app's APK in one rolling public release.

The design rule: Morphe will change again, so everything Morphe-specific lives in one config block and one source file.

## Decisions so far

| Topic | Decision |
|---|---|
| Sources | Decided by Phase 0: APKMirror through FlareSolverr first, APKPure's app API second, archive.org (j-hc's mirror) last. No manual override. |
| Per-app patch options | None. Each app gets its bundle's default patches and is configured in the app. |
| Target version | Asked from the Morphe CLI (`list-versions`), not parsed from each bundle's own JSON. Works for any bundle. |
| Authenticity | Every stock APK and split must match a pinned signing certificate before patching. |
| Signing | Patch with `--unsigned`; sign in a separate job that alone holds the keystore. Reuse the Morphe Manager keystore so existing installs update in place. |
| Publishing | Public repo, one release tagged `latest`, one asset per app; only the patched app's asset is replaced. |
| Alerts | A failed run is red. A failing app also gets one GitHub issue, opened by the workflow, updated instead of duplicated, and closed when the app builds again. No ntfy, no Discord webhook. |
| Experimental app versions | Not used, matching Morphe's own default. |
| TikTok | `com.zhiliaoapp.musically` only; the `trill` package is not needed. |
| Not included | Google Play download tier, rolldown, Alchemy, trawl, apkeep, Uptodown, a manual APK URL input. |

## Tools

| Tool | Verdict | Role |
|---|---|---|
| Bun 1.4 | Use | Runtime and test runner. Runs the TypeScript directly. |
| Effect 4.1 (`effect` 4.1.3) | Use | The build tool: Schema for the config, typed errors, `Schedule` for retries, `@effect/platform-bun` for processes, files and HTTP. |
| `@effect/tsgo` 0.67.7 + TypeScript 7 | Use | Type check (`effect-tsgo tsc --noEmit`) and Effect-aware lint rules for oxlint. |
| oxlint 1.93, oxfmt 0.78 | Use | Lint and format. oxfmt is still pre-1.0. |
| rolldown | Not worth it | There is nothing to bundle or ship. |
| Alchemy v2 | Not used | Nothing left for it to do. See below. |
| `gh` CLI script | Use | `scripts/setup-repo.sh` applies the repo settings, the `release` environment, the ruleset and the security toggles. Run once from this machine. |
| Infisical | Use | The one place secrets live. |
| varlock 1.24 + `@varlock/infisical-plugin` 2.1 | Use | `.env.schema` declares each secret and where it is in Infisical; `@varlock/effect-plugin` generates a typed Effect `Config` module from it. |
| varlock GitHub Action 1.0.5 | Not used | Its one job was handing the review key to PR-Agent. Pullfrog keeps its own credentials. |
| Renovate | Use, instead of Dependabot | Updates packages, actions, image digests and the pinned tools in `auto-apk.json`. |
| FlareSolverr 3.5.2 (container, pinned by digest) | Use, in the `build` job only | Gets APKMirror pages past Cloudflare from GitHub's runners. The APK itself is then fetched directly with its cookies and user agent. |
| trawl 1.11 | Dropped after Phase 0 | Blocked on GitHub's runners ("datacenter-ip-blocked") on the pages that mattered, where FlareSolverr got through. |
| apkeep 1.1.0 | Dropped after Phase 0 | For APKPure it is one API call plus a download. It exits 0 with no file when a version is missing. `Sources.ts` makes the same call itself. |
| Pullfrog (`pullfrog/pullfrog` action, v0.1.126) | Use | AI pull request review in our own Actions, on your Grok subscription, with Claude as a second opinion. Free for a public repo on a personal account. |

**Why Alchemy is out.** Its job kept shrinking. It never ran the builds. Then Infisical through varlock took secrets away from it, which was the part that needed a real tool. What remained was two resources, the repo and the `release` environment: about six settings, set once. For that it brought a beta package, a state file to keep, and a second mechanism beside the manual steps for the ruleset and security toggles its GitHub provider does not cover. One `gh` script does all of it in one place with no state. If the project ever grows real infrastructure, Alchemy can come back.

## Secrets: Infisical through varlock

Infisical holds the signing secrets, the only secrets the build itself needs. Nothing is stored in GitHub secrets. The `publish` job logs in to Infisical with GitHub's own short-lived OIDC token, through `@varlock/infisical-plugin`.

```
Infisical project `auto-apk`
   /signing    keystore, passwords, alias
        |
        |- publish job   OIDC -> identity bound to environment `release` -> /signing
        |                loaded by:  varlock run -- bun src/main.ts publish
        `- this machine  your own Infisical machine identity, for local test signing

Pullfrog's encrypted store (outside Infisical, see "AI pull request review")
   Grok sign-in, Claude subscription token
        `- released only to a run of this repo's pullfrog.yml that proves itself with OIDC
```

- One machine identity, read-only on `/signing`. Its OIDC rule must match the subject `repo:<owner>/auto-apk:environment:release` exactly, not just the repository. `pullfrog.yml` also runs on `main` with `id-token: write`; a rule bound only to the repository would let that job, or the agent inside it, ask for the keystore.
- One schema file, `.env.schema`, for the signing secrets.
- The `build` job has no identity and no `id-token` permission, so code that handles downloads and third-party bundles cannot ask Infisical for anything.
- This machine's identity is the one credential that exists outside Infisical. It stays in a git-ignored `.env.local` and is needed only for local signing tests.
- **The review credentials are the one exception to "Infisical only".** Pullfrog's Grok credential rotates on every refresh, and Pullfrog has to write the new one back after each run. A secret that GitHub or Infisical injects cannot be updated like that, so Pullfrog's docs say to keep subscription credentials in its own store. They can reach nothing in the build: no keystore, no release write.

**The varlock GitHub Action** is no longer needed. Its only job was handing the OpenRouter key to PR-Agent. `publish` keeps using `varlock run`, which gives the keystore to our one signing process and to no other step.

## Phase 0: source bake-off

**Status: decided 2026-11-11 on one day's runs. Two more daily runs (09:17 UTC, GitHub runner plus this machine) confirm or overturn it before Phase 1 code depends on it.** Repo: `teyd/auto-apk-bakeoff` (public, throwaway). Raw results in its `results/`, details in its `FINDINGS.md`.

### Result

Target versions from `list-versions` on 2026-11-11, all 8 apps; every downloaded file matched its pin and patched completely (applied = expected).

| Source, route | This machine | GitHub runner |
|---|---|---|
| APKMirror, plain HTTP | blocked after ~10 quick requests | 5 of 8 (Cloudflare on Instagram, Discord, some Gboard pages) |
| APKMirror, through trawl | 8 of 8 | 5 of 8, browser solve refused: "datacenter-ip-blocked, needs residential proxy" |
| **APKMirror, through FlareSolverr** | 8 of 8 | **8 of 8**, 24 to 67 s per app, 4 to 5 page loads each |
| **APKPure, app API** | 7 of 8 | **7 of 8**, 3 to 13 s per app; no YouTube 21.30.216 (not on the site in any locale either) |
| **archive.org, j-hc's mirror** | YouTube, Reddit, X targets present | YouTube 21.30.216 in 79 s, pin matched |
| Uptodown | lists the YouTube target | download link is now built by JavaScript; dropped |

Why this order:
- **APKMirror first.** It is the only source with every target version, and the bundles' preferred file types.
- **APKPure second.** It is fast and covers everything except YouTube today.
- **archive.org last.** It holds only the apps j-hc builds, but it has no Cloudflare in front, so it is the independent backstop for YouTube.
- **The pin is what makes three sources safe.** A file from any of them must carry the publisher's certificate.

Other findings that changed the design:
- `result.json` has no list of skipped patches. On a version Morphe does not support it reports `success: true`, 0 applied, 0 failed, and exits 0: a stock app that looks like a successful build. Only applied = expected (from `list-versions`) catches it.
- YouTube, Instagram and Gboard carry a second, rotated v3.1 signing key. The pin is the original key, and the check is "pin is among the signers", not "signers equal pin".
- `list-versions` output needs care: ties are listed oldest first, Discord's line reads `351.11 - Stable`, Gboard's is the full `18.5.4.993608717-release-arm64-v8a`, and some lines carry per-arch versionCodes.
- On Oct 10, 2026 APKMirror's operator tightened Cloudflare on all regular pages (a 5-minute challenge after 20 requests in 15 seconds), and asked projects to stop borrowing APKUpdater's user agent and API credential. We use neither, and stay far under that rate.

### How it was run

A throwaway repo with one workflow and two small scripts. No Effect, no config format, nothing worth keeping.

**What ran.** For each of the 8 apps at its current target version, fetch the stock app from both sources, then patch each downloaded file with Morphe and its bundle. Run on `ubuntu-latest` and on this machine, three times on different days.

**What was recorded per app, per source, per run.**

| Measure | Why it matters |
|---|---|
| Exact target version found | Bundles lag the store, so old versions are the normal case. |
| Download succeeded, and how long it took | Reliability from a datacenter IP is the main unknown for both. |
| File type (APK, XAPK, APKM) and size | Some bundles ask for a specific type. |
| Signing certificate matches the publisher's | Authenticity. |
| Morphe applied every patch, none skipped | A file that downloads but patches badly is useless. |
| Setup weight (binary against container, start-up time) | Cost on every run. |
| Lines of code needed | apkeep is one command; APKMirror needs a three-page walk. |

**What I expected beforehand.** APKPure wins on simplicity and speed and misses YouTube 21.30.216. APKMirror has every version; its risk is being blocked on runners. Both held; the block was real, and FlareSolverr, not trawl, got past it.

The same runs answered the Morphe unknowns: `list-versions` gives a usable answer for all six bundles with no trust prompt, and `result.json` is described above. Still open, and needing your phone: whether a patched APK installs and runs, and whether the Morphe Manager keystore works with `apksigner` and updates an existing install in place.

## Patch sources (checked 2026-11-11)

| App | Bundle | Stable tag | Package | Target version | Store version |
|---|---|---|---|---|---|
| Instagram | crimera/piko | v3.11.1 | com.instagram.android | 452.1.0.53.64 | not confirmed |
| X | crimera/piko-newx | v3.75.0 | com.twitter.android | 12.41.0-prod.01 | 12.41.0-prod.01 |
| Gboard | jasonwu1994/Gboard-patches | v4.2.0 | com.google.android.inputmethod.latin | 18.5.4 (arm64) | 18.5.9+ |
| Discord | VenusIsJaded/Venus-Patches | v1.21.1 | com.discord | 351.11 | 353.11 |
| TikTok | SysAdminDoc/HushFeed | v0.81.0 | com.zhiliaoapp.musically | 47.7.2 | 47.7.3 |
| Reddit | MorpheApp/morphe-patches | v2.2.0 | com.reddit.frontpage | 2026.40.0 (2026.45.0 experimental) | 2026.45.0 |
| Twitch | jordanwoodson/lurk-morphe-patches | v1.16.1 | tv.twitch.android.app | 31.8.0 | 32.0.0 |
| YouTube | MorpheApp/morphe-patches | v2.2.0 | com.google.android.youtube | 21.30.216 (21.45.82 experimental) | 21.45.82 |

- APKPure's API listed the exact target for 7 of the 8 (not YouTube 21.30.216) when queried from this machine.
- lurk and Venus are about a month old, pseudonymous, and the only options found.

## The workflow

Four jobs in one file. Only `publish` can see the keystore.

```
build.yml   (cron every 6h, workflow_dispatch; runs queue, never overlap)

  plan      validate config; read manifest.json from the release; get each bundle's
            latest stable release; ask Morphe which app versions it supports;
            output a matrix of apps whose inputs changed. Empty matrix: stop here.

  build     matrix, one leg per changed app, fail-fast off, no secrets
            download stock app -> verify certificate pin ->
            morphe patch --unsigned -> check result.json -> upload artifact

  publish   one job, environment `release` (the only job allowed to read the keystore)
            download artifacts -> apksigner sign + verify -> attest ->
            replace only those apps' assets -> rewrite manifest.json and release body

  report    always runs after build and publish; `issues: write`, nothing else
            open, update or close one issue per app (see "Alerts")
```

- Most runs find nothing new and end after `plan`.
- One failing app does not block the others; the run still ends red, and `report` opens an issue for it.
- One job writes the release, so two apps cannot race on `manifest.json`.
- Code that handles untrusted downloads and third-party bundles never runs in a job that holds the key.

### Alerts

Each `build` leg writes a small result file (app, target version, sources tried and why each failed, or the gate that rejected the file). `report` reads them all:

- **An app failed:** if no open issue titled `Build failing: <app>` exists, open one, labelled `build-failure`. If one exists, add a comment only when the reason changed, so a source that stays down does not post every 6 hours.
- **An app built and published:** close its open issue with a comment linking the run.
- **The body says what to do:** the reason per source, the target version, the run link. A certificate-pin mismatch is called out at the top, because it can mean a tampered file rather than an outage.

GitHub notifies you about issues the workflow opens in your repo, by email and in the mobile app. Nothing new to store: `report` uses the workflow's own token.

From the `github-actions-efficiency` skill: a `concurrency` group; caches keyed by pinned version (Bun install, Morphe jar); Java set up only where it is used; every action pinned by commit SHA; `timeout-minutes` on every job; `contents: read` by default, `contents: write` only on `publish`, `issues: write` only on `report`.

Two more workflows:
- `ci.yml`: `effect-tsgo tsc`, oxlint, `oxfmt --check`, `bun test`, schema-is-current, `auto-apk check`, `actionlint`, `zizmor`. Skipped when a pull request touches only docs.
- `pullfrog.yml`: Pullfrog's review agent. It has only a `workflow_dispatch` trigger; the Pullfrog app dispatches it on `main` when a pull request opens or someone mentions `@pullfrog`. See "AI pull request review".

## The config file

One file, `auto-apk.json`. Its JSON Schema is generated from the Effect Schema in `src/Config.ts` and committed, so the two cannot drift. Every field has a description that editors show on hover. Unknown keys are rejected, so a typo fails `auto-apk check` instead of being ignored.

| Section | Question it answers |
|---|---|
| `tools` | Which exact versions of the tools run? |
| `defaults` | What applies to every app unless it says otherwise? |
| `publish` | Where do results go and how are files named? |
| `apps` | Which apps are built, with whose patches, from where? |

```json
{
  "$schema": "./schema/auto-apk.schema.json",
  "configVersion": 1,

  "tools": {
    "morphe": {
      "repo": "MorpheApp/morphe-desktop",
      "version": "2.1.1",
      "asset": "^morphe-desktop-.*-all\\.jar$",
      "sha256": "...",
      "java": 21,
      "jvmArgs": ["-Xmx4g"]
    },
    "flaresolverr": { "image": "ghcr.io/flaresolverr/flaresolverr:v3.5.2@sha256:c80ae007ce2c..." }
  },

  "defaults": {
    "enabled": true,
    "arch": "arm64-v8a",
    "experimental": false,
    "version": "auto",
    "sources": ["apkmirror", "apkpure", "archive"],
    "patches": { "asset": "^patches.*\\.mpp$", "channel": "stable" }
  },

  "publish": {
    "repo": "<owner>/auto-apk",
    "tag": "latest",
    "asset": "{app}-{appVersion}-p{patchesVersion}-{arch}.apk"
  },

  "apps": {
    "youtube": {
      "name": "YouTube",
      "package": "com.google.android.youtube",
      "patches": { "repo": "MorpheApp/morphe-patches" },
      "signature": "3d7a1223...",
      "sources": {
        "apkmirror": { "url": "https://www.apkmirror.com/apk/google-inc/youtube/" },
        "apkpure": {},
        "archive": { "url": "https://archive.org/download/jhc-apks/apks/com.google.android.youtube" }
      }
    },
    "x": {
      "name": "X",
      "package": "com.twitter.android",
      "patches": { "repo": "crimera/piko-newx" },
      "signature": "0fd9a0cf...",
      "sources": {
        "apkmirror": { "url": "https://www.apkmirror.com/apk/x-corp/twitter/" },
        "apkpure": {},
        "archive": { "url": "https://archive.org/download/jhc-apks/apks/com.twitter.android" }
      }
    }
  }
}
```

Rules of the format:
- **An app needs five things:** name, package, patches repo, signature, source links. Everything else comes from `defaults`.
- **An app overrides any `defaults` key by repeating it**, for example `"enabled": false`, or `"version": "21.30.216"` to hold a version.
- **`sources` in `defaults` is the order; `sources` in an app is the links.** A source an app does not list is skipped. APKPure needs no link (the package name is enough), so it appears as `{}`. `archive` is listed only for apps j-hc mirrors (YouTube, Reddit, X today).
- **Apps that share a patches repo** (YouTube and Reddit) name the same repo; it is downloaded once.
- **Patches follow their latest release on the chosen channel; tools are pinned by version and SHA-256.** What was actually built is recorded in `manifest.json`.
- **No secrets and no patch options.**
- **`configVersion`** lets a later format change be detected.

Secrets are not in this file. `.env.schema` declares them and says where in Infisical each one is; it holds no value. It has `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`, all sensitive and required. The release upload uses the workflow's own `GITHUB_TOKEN`.

## Where a Morphe change lands

| Change | Edit |
|---|---|
| New Morphe release | `tools.morphe.version` and `sha256` |
| Repo or jar renamed again | `tools.morphe.repo`, and `asset` only if the regex no longer matches |
| Flag renamed, `list-versions` output or `result.json` reshaped | `src/Morphe.ts`, the only file that runs the jar |
| New patch bundle or bundle format | nothing in code; Morphe reads the bundle |
| Newer Java required | `tools.morphe.java` |

`src/Morphe.ts` runs two commands:

```
java -jar <jar> list-versions --patches <bundle> -f <package> [--include-experimental]
java <jvmArgs> -jar <jar> patch -p <bundle> --striplibs <arch> -t <temp> --unsigned \
  -o <out>.apk -r <out>.result.json <absolute input path>
```

- Version choice: supported versions ranked by how many patches support them, newest first on ties. If the best cannot be downloaded, the next is tried, never going to or below the version already published.
- No `--force`, no `--continue-on-error`. A version mismatch makes Morphe skip patches and still exit 0, so the build fails if `result.json` reports a skipped or failed patch.
- Split bundles go to the CLI untouched, by absolute path; a stale output file is deleted first.
- A failed build never touches the published asset.

## Download and verification

Order set by Phase 0, tried in turn until one passes the gate below:

1. **APKMirror through FlareSolverr.** The container starts only when this source is reached. App page, release page, variant page and download page go through FlareSolverr's `/v1` API (4 or 5 loads, a 3 s pause between them). The release slug is derived from the app's own release links, never from the sidebars. The variant chosen is APK before bundle, `arm64-v8a` or universal, `nodpi` first. The APK is then fetched directly with FlareSolverr's cookies and user agent. Our own user agent, no borrowed credentials.
2. **APKPure's app API.** One GET to `api.pureapk.com/m/v3/cms/app_version` with the app's headers, pick the exact version, download. Returns an APK or XAPK. "Version not listed" is a typed error, not a silent empty result.
3. **archive.org (j-hc's `jhc-apks`).** A directory listing and a download. Only for apps the config lists it for.

If every source fails, the build fails for that app and the report job opens an issue (see "Alerts").

All pass the same gate: `apksigner verify --print-certs` on the APK, or on every APK inside a bundle, must equal the app's `signature`, and package name and version must match. An HTML challenge page saved as an "APK" fails here.

Pins: X, YouTube, Reddit and Twitch from j-hc's published list; Instagram and TikTok from the signatures HushGram and HushFeed publish; Gboard and Discord recorded in Phase 0, where APKMirror and APKPure agreed. YouTube, Instagram and Gboard pins are the original v3.0 key; their rotated v3.1 key is also present and ignored.

## Signing and publishing

- One private PKCS12 keystore, never in the repo. Export the one from Morphe Manager and use it; otherwise every existing install must be uninstalled first. Keep an offline copy.
- One release, tag `latest`. `publish` deletes the patched app's previous asset and uploads the new one. Other assets are not touched.
- `manifest.json` (per app: app version, patches tag and SHA-256, input hash, APK SHA-256, build time) is the public index and the pipeline's state. The release body is a table generated from it.
- Build attestations, so anyone can check an APK came from this workflow.
- The version stays in the filename so Obtainium has something to compare. One Obtainium entry per app with an asset regex such as `^youtube-`.
- MicroG-RE is tracked in Obtainium from `MorpheApp/MicroG-RE`; YouTube needs it on the device.

## Repository setup

Best practice for a one-person public repo that publishes binaries. Everything in this section that is a GitHub setting is applied by one script, `scripts/setup-repo.sh`, which calls `gh api`. It is safe to run again, so the script is both the setup and the record of what the settings should be. You run it once from this machine with your own `gh` login; CI never runs it.

**Settings**
- Description, topics, wiki and projects off, issues on.
- Squash merge only, delete branch on merge, auto-merge allowed.
- `release` environment restricted to `main`. Only a job running in it can read the signing secrets from Infisical.
- Actions: workflow token read-only by default, actions pinned to a full commit SHA, workflows from forks need approval.

**Rules on `main`** (a ruleset, kept as JSON in `.github/rulesets/`)
- Changes arrive by pull request; no direct or force pushes; linear history.
- `ci` must pass before merge. No required approvals, since you cannot approve your own pull request.

**Security**
- Secret scanning with push protection, Dependabot alerts, private vulnerability reporting, CodeQL default setup. All free on public repos.
- `SECURITY.md`; `actionlint` and `zizmor` in `ci.yml`.

**Dependencies: Renovate, not Dependabot, not both.**

| | Dependabot | Renovate |
|---|---|---|
| Bun packages, GitHub Actions by SHA, container digests | Yes | Yes |
| Versions written in our own file (`tools.morphe`, `tools.flaresolverr` in `auto-apk.json`) | No | Yes, with a custom rule that reads GitHub releases |
| One dashboard issue listing everything pending | No | Yes |
| Wait a few days before proposing a fresh release | Yes | Yes |
| Setup | Built into GitHub | Install the free Mend-hosted GitHub app |

- The deciding row is the second one. The tools this project depends on most (Morphe, FlareSolverr) are not npm packages. With Dependabot I had planned a hand-written weekly job to bump Morphe; Renovate does that from configuration, and that job is removed from the plan.
- Running both means two bots opening pull requests for the same bump. So Dependabot's version updates stay off. Dependabot **alerts** stay on: they are GitHub's vulnerability feed, cost nothing, and Renovate reads them to open the fix.
- Settings: weekly, non-major updates grouped into one pull request, majors separate, three-day minimum release age, auto-merge off.
- Morphe's `sha256`: Renovate bumps `tools.morphe.version` only. A `ci` step downloads the configured jar and fails until `tools.morphe.sha256` matches, printing the hash to paste. CI never gets write access, and you see the new hash in the diff before merging.
- `bun.lock` committed; CI installs with `--frozen-lockfile`; Bun version pinned in `package.json`.

**Files**
- `README.md` (what it builds, installing with Obtainium, changing the config, a disclaimer that the APKs are unofficial).
- `LICENSE` (MIT for this tool's own code unless you prefer another), `SECURITY.md`, `CODEOWNERS`, a short pull request template.
- `.editorconfig`, `.gitattributes`, `.gitignore` (keystores, `.env.local`, build output).

**Habits**
- Conventional commit titles; the squash commit takes the pull request title.
- No keystore, token or stock APK ever enters git.

## Repository layout

```
auto-apk/
  auto-apk.json                  # the config
  schema/auto-apk.schema.json    # generated, committed
  .env.schema                    # signing secrets: names, types, Infisical locations (varlock)
  AGENTS.md                      # what the project is and what matters, read by the review agent
  renovate.json                  # dependency and tool updates
  scripts/setup-repo.sh          # repo settings, release environment, ruleset, security toggles, Pullfrog settings
  .github/
    workflows/{build,ci,pullfrog}.yml
    rulesets/main.json
    CODEOWNERS  pull_request_template.md
  src/
    main.ts          # subcommands: check, plan, build, publish, schema
    Config.ts        # Effect Schema for auto-apk.json
    env.generated.ts # from .env.schema
    GitHub.ts        # release lookup, asset download and replace
    Sources.ts       # apkmirror (via FlareSolverr), apkpure (app API), archive
    Verify.ts        # certificate pin gate
    Morphe.ts        # the only Morphe-specific code
    Release.ts       # sign, manifest, release body
  test/
  README.md  LICENSE  SECURITY.md  .editorconfig  .gitattributes  .gitignore
  package.json  bun.lock  tsconfig.json  bunfig.toml  .oxlintrc.json  .oxfmtrc.json
```

Each workflow job calls one subcommand, and the same subcommands run locally.

## Phases

**Phase 0: source bake-off.** Decided (see "Phase 0"); two confirming daily runs left. Still needs your phone for the install and keystore tests.

**Phase 1: scaffold, repo and config.** In progress since 2026-11-11: repo `teyd/auto-apk` is public and `scripts/setup-repo.sh` has been applied (without Pullfrog). Remaining: Pullfrog app and subscriptions, Infisical project and identity, Renovate app. Bun project, `@effect/tsgo`, oxlint, oxfmt, `Config.ts`, generated schema, `auto-apk.json` for 8 apps. Then secrets: the Infisical project, its one machine identity, `.env.schema`. Then the repository: `scripts/setup-repo.sh`, the `main` ruleset, community files, `renovate.json`, `ci.yml`. Then review: install the Pullfrog app, connect the Grok and Claude subscriptions, add `pullfrog.yml` and `AGENTS.md`, and check a first review on a test pull request. From here on every change goes through a pull request.

**Phase 2: build path.** `GitHub`, `Morphe`, `Sources`, `Verify`. Done when `auto-apk build --app x` produces an unsigned patched APK locally and all 8 build, or the gap is named per app.

**Phase 3: release path.** `Release.ts`, `build.yml` with the three jobs, attestations, Obtainium entries.

**Phase 4: hardening.** Retries with backoff, image digests pinned, README with the "where a Morphe change lands" table.

## AI pull request review

Pullfrog (`pullfrog/pullfrog`, v0.1.126, docs read 2026-11-11). It is not a model or an agent of its own. A GitHub App listens for pull request events and dispatches our `pullfrog.yml` on GitHub's runners. The action then runs the vendor's own agent: Claude Code for an Anthropic model with Anthropic credentials, OpenCode for anything else. It posts one review: a summary, inline comments, and suggested changes you can commit from the thread.

**Cost: nothing on top of what you already pay.** Pullfrog is free for public repositories and for personal accounts, Smart model selection included. Tokens come from your subscriptions, not from an API bill.

### Your subscriptions, and what each one does

| You have | Role | Why |
|---|---|---|
| Grok subscription (SuperGrok or X Premium) | **Writes every review (default).** Smart on the xAI provider picks Grok 4.3 for small or behaviour-free diffs and Grok for larger ones. | Your choice. Runs through OpenCode, since Pullfrog uses a vendor's own agent only for Anthropic and OpenAI models. |
| Claude subscription | **Second opinion.** Before posting, the review sends each finding to Claude Sonnet and drops any it cannot re-verify. | This is the pass CodeRabbit runs to drop findings it cannot support, using quota you already pay for. A different vendor's model catches different mistakes. It also keeps the Claude connection in use. |
| OpenCode subscription | Not used | Go offers GLM, Kimi, Qwen and similar, and Grok already covers every rung of the ladder at no extra cost. Kept as an option if Grok quota ever runs short. |
| OpenRouter | Not used | Pullfrog falls back only between credentials of the same provider. An OpenRouter key would never stand in for a Grok run that hit its limit. It would help only as a paid primary, and that is what the subscriptions make unnecessary. |

**Two things to know about Grok as the default.**
- **Its sign-in rotates.** An xAI access token lasts about six hours, and xAI replaces the refresh token every time it is used. Pullfrog refreshes before each run and saves the new token after. If the repo goes quiet long enough for the refresh token to lapse at xAI, the next review fails with `GROK_AUTH_JSON was rejected by xAI`. The fix is to run `npx pullfrog auth grok` again. Renovate's weekly pull requests do not start reviews, so they do not keep it alive. If it lapses often, add an `XAI_API_KEY` as the fallback, which Pullfrog tries next on its own, at API prices.
- **Usage limits.** When the Grok plan hits its usage window, the run fails with a comment saying so. Re-trigger with `@pullfrog review` after the reset, or once with `--sonnet` to use Claude instead. The review is not a required check, so neither case ever blocks a merge.

Quota use stays small. About 15 pull requests a month, most of them one-line Renovate bumps, which are not reviewed at all (see below).

### Settings

The Pullfrog CLI reads and writes the same settings as the web console, so `scripts/setup-repo.sh` applies them with `npx pullfrog config set ... --repo <owner>/auto-apk --yes`. The script stays the single record of repository settings.

| Key | Value | Why |
|---|---|---|
| `model` | unset, Smart on the xAI provider | Grok 4.3 and Grok by diff size |
| `review.mode` | `agent` | Review every new pull request |
| `review.re-review` | `true` | Each push gets an incremental review of only the new commits. Quota, not money. |
| `review.non-collaborators` | `false` | On a public repo, anyone's pull request would otherwise spend your Grok quota |
| `review.drafts`, `review.approve`, `auto-merge` | `false` | Comments only; you merge |
| `review.status-check` | `true` | Shows "Pullfrog is running" on the pull request; not made required |
| `push` | `disabled` | The reviewer cannot push, even to a feature branch |
| `shell` | `restricted` | Default-deny environment for any command the agent runs (always on for public repos) |
| `mention.enabled` | `true`; `mention.non-collaborators` `false` | You can ask `@pullfrog` a question on a pull request; strangers cannot |
| `address-reviews.enabled`, `fix-ci.*` | `false` | It does not write code here |
| `issue.mode` | `none`; `label.enabled` `false` | No issue triage |
| `instructions` | Ask Claude Sonnet to refute each finding before posting, at most 6 asks per run | The second opinion |
| `prompts.review` | From `.github/pullfrog/review.md` | What to look hardest at; see below |

"Include PRs opened by bots" stays off, its default, so Renovate's pull requests get no review; CI checks those.

### What the review is told to focus on

`.github/pullfrog/review.md`, set as the review prompt. Kept short:

- Anything that could let the `build` job, a patch bundle or a download reach the keystore, the release, or an `id-token`.
- Workflow `permissions:`, unpinned actions, `pull_request_target`, script injection from `${{ }}` in `run:`.
- The certificate pin gate in `Verify.ts`, and the applied-against-expected patch count in `Morphe.ts`. Any change that weakens either is a defect.
- Changes to `auto-apk.json` pins or tool hashes: say what changed.

`AGENTS.md` at the root describes the project for the agent, and later for any coding agent you use locally.

### The workflow

```yaml
# .github/workflows/pullfrog.yml
name: Pullfrog
run-name: ${{ inputs.name || github.workflow }}
on:
  workflow_dispatch:
    inputs:
      prompt: { type: string, description: Agent prompt }
      name: { type: string, description: Run name }
permissions:
  contents: read
jobs:
  pullfrog:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      id-token: write    # Pullfrog mints its own short-lived GitHub token and fetches stored credentials
      contents: read
    steps:
      - uses: actions/checkout@<sha> # v7
        with: { fetch-depth: 1, persist-credentials: false }
      - uses: pullfrog/pullfrog@88bcc3d4bb26951b99fafe09f65d90d20d5b6d62 # v0
        with:
          prompt: ${{ inputs.prompt }}
```

- No `env:` block: no key lives in GitHub.
- It runs from `main` only, because the app dispatches it on the default branch. A pull request cannot change the workflow that reviews it.
- The SHA pin fixes the action's inputs, not all of its code. The action is a thin bootstrap that loads its code from npm at `^0.1.x`, so patch releases arrive without a pin change. Renovate bumps the SHA for minor releases.

### Security

What stops a hostile pull request from doing harm through the reviewer:

- Pull request text reaches the model as tool output, not as instructions.
- `push` is disabled, and runs started by non-collaborators get a read-only git token regardless.
- Shell commands get a default-deny environment in their own PID and mount namespace. Names ending in `_TOKEN` or `_KEY` never pass, `.git` is read-only, and `$GITHUB_ENV` cannot be written.
- Stored credentials are released only to an OIDC-verified run of this repository. Fork pull requests get no OIDC token.
- The keystore stays out of reach because the Infisical rule requires the `release` environment, which this job does not have.

### One-time setup, by you

1. Install the Pullfrog GitHub App on your account with access to `auto-apk` only.
2. In a clone of the repo: `npx pullfrog auth grok` (device code, works over SSH).
3. `npx pullfrog auth claude`. On a machine without a browser, use `--paste-token` with the output of `claude setup-token` from a machine that has one.
4. Merge `pullfrog.yml`, then run `scripts/setup-repo.sh` to apply the settings above.

## Settled this round

- **Alchemy v2: dropped.** With secrets fetched from Infisical at run time there is nothing left for it to deploy except a handful of repo settings. One `gh` script sets those, and also the ruleset and security toggles Alchemy could not. See "Tools" and "Repository setup".
- **Pullfrog replaces PR-Agent.** Reviews run on your Grok subscription by default, with Claude as the second opinion. That removes `review.yml`, `.pr_agent.toml`, the OpenRouter key, the varlock GitHub Action, the Infisical `/review` folder, its identity and the second schema file. See "AI pull request review".
- **Experimental versions: not used.** Morphe does not use them by default. The CLI lists them only with `--include-experimental`, and Morphe Manager offers them only in Expert mode. So `experimental` stays `false` for every app, YouTube and Reddit included, and builds follow the versions Morphe itself recommends (YouTube 21.30.216, Reddit 2026.40.0 today). The per-app switch stays in the config, unused.
- **TikTok `trill` variant: not needed.** `com.zhiliaoapp.musically` and `com.ss.android.ugc.trill` are the same app under two package names; Google Play hands out `trill` in some regions, mostly in Asia. A sideloaded `musically` build installs and runs in any region. If your phone currently has the `trill` one, uninstall it once so you do not end up with two TikToks.

## Open questions

None. If the two remaining Phase 0 runs disagree with the first, the source order comes back here.

## Risks

- **Public release.** Google sent GitHub a DMCA notice in March 2024 naming release assets of patched YouTube. A takedown would hit the repo; `publish.repo` is one setting.
- **Young dependencies.** `@effect/tsgo` and oxfmt are pre-1.0, FlareSolverr depends on a browser staying ahead of Cloudflare, Pullfrog is at 0.1.x and loads its code from npm at run time. All except FlareSolverr sit outside the build path, so a break delays a lint or a review, not a build.
- APKMirror's operator has said unattended downloading is unwelcome, and tightened Cloudflare in Oct 2026 against clients that hammer pages. APKPure has a history of serving modified apps. The certificate pin covers the second. For the first: one walk per new version (4 or 5 page loads), a pause between loads, our own user agent, no borrowed credentials, and most runs never reach APKMirror at all.
- **The archive.org source is one person's mirror** (j-hc). It can disappear or lag. It is the last fallback, and the pin covers tampering.
- **Cloudflare can start refusing FlareSolverr on runners**, as it already refuses trawl. Then APKPure carries 7 of 8 and archive.org YouTube; the issue says which app is stuck. The next step would be a self-hosted runner on this machine, where trawl and FlareSolverr both passed.
- GitHub disables cron workflows in public repos after 60 days without repository activity; release uploads may not count. Phase 3 checks this and adds a keep-alive if needed.
- Venus's README flags two of its Discord patches as against Discord's rules; patched clients carry account risk on Instagram, Discord and TikTok.
- Four of six bundle repos are single-maintainer and under three months old. A malicious release would be built; the build job holds no secrets, but the APK would still reach your phone.
- An AI reviewer reads untrusted pull request text. It cannot push and its shell is sandboxed, so the worst case is a misleading comment.
- **Pullfrog is a third-party service holding two of your subscription credentials** (Grok, Claude), and its app can dispatch workflows in the repo. A Pullfrog compromise could spend your quota or post comments. It could not reach the keystore, because the Infisical rule requires the `release` environment, and it could not merge, because of the ruleset. To cut it off: remove both connections with `npx pullfrog auth remove`, revoke the Claude token and the Grok sign-in at Anthropic and xAI, and uninstall the app.
- **Infisical is now on the release path.** If it is down, `publish` fails and the next scheduled run rebuilds and retries. Nothing is published unsigned or half-done.
- **Renovate is a third-party app** with permission to open pull requests. It cannot merge: the `main` ruleset and CI still gate everything, and auto-merge stays off.

## Not verified

Phase 0 rests on one day; two daily runs remain. Also: the Instagram store version; that APKPure's app API accepts our own client headers the way it accepts apkeep's; how Obtainium detects a changed asset under an unchanged tag; that `list-versions` has no machine-readable output mode. For the review: Pullfrog was read from its docs (docs.pullfrog.com, 2026-11-11) and README, not run; that Smart is free on a personal account, that the CLI keys listed are all writable on a personal repo, how much of the Grok plan a review uses, how long an unused Grok sign-in lasts before it lapses, and that Claude answers as a second opinion reliably are to be confirmed on the first test pull request. For Infisical: its free-plan limits on machine identities, and that a base64 keystore fits in one secret value; the varlock plugin's OIDC path was read from its docs, not run. For `scripts/setup-repo.sh`: the exact `gh api` calls are not written or tried yet. For Renovate: whether it can update the Morphe jar's SHA-256 itself. Morphe's handling of experimental versions is from Morphe Manager's README and the CLI flag, not from running either. Phase 0 ran the Morphe jar and downloaded real APKs, but nothing has been signed or installed yet.
