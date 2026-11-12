/**
 * Turn build records into GitHub issues: one open issue per failing app, updated
 * only when the reason changes, closed when the app builds again.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { BuildRecord } from "./Build.ts"
import * as GitHub from "./GitHub.ts"

export const LABEL = "build-failure"
export const issueTitle = (app: string) => `Build failing: ${app}`
/** One issue for a publish failure, instead of one per app it affected. */
export const PUBLISH_TITLE = "Publish failing"
export const PUBLISH_REASON = "built, but signing or publishing failed (see the publish job)"

const MARKER = "auto-apk:reason="

/** A fingerprint of why a build failed, stable across runs (URLs and keys removed). */
const strip = (s: string) =>
  s.replace(/https?:\/\/\S+/gu, "<url>").replace(/\b[0-9a-f]{32,}\b/gu, "<hex>")

export const fingerprint = (record: BuildRecord): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(
    JSON.stringify([
      strip(record.reason ?? ""),
      record.attempts.map((a) => [
        a.version,
        a.source,
        a.ok,
        a.pinMismatch ?? false,
        strip(a.error ?? ""),
      ]),
    ]),
  )
  return hasher.digest("hex").slice(0, 16)
}

const escapeCell = (s: string) =>
  s.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\n/gu, " ")

export const issueBody = (record: BuildRecord, runUrl: string): string => {
  const pin = record.attempts.some((a) => a.pinMismatch)
  const lines = [
    ...(pin
      ? [
          "> [!CAUTION]",
          "> A download was validly signed, but **not by the pinned certificate**. This can mean a",
          "> tampered file. Do not change the app's `signature` without checking where the new",
          "> certificate comes from.",
          "",
        ]
      : []),
    `**${record.app}** could not be built: ${record.reason ?? "unknown reason"}`,
    "",
  ]
  if (record.attempts.length > 0) {
    lines.push("| Version | Source | Result |", "|---|---|---|")
    for (const a of record.attempts) {
      const result = a.ok
        ? "ok"
        : `${a.pinMismatch ? "**pin mismatch** " : ""}${escapeCell(a.error ?? "failed").slice(0, 300)}`
      lines.push(`| ${escapeCell(a.version)} | ${a.source} | ${result} |`)
    }
    lines.push("")
  }
  lines.push(
    `Patches: \`${record.patches.repo}\` ${record.patches.tag || "(unknown)"} · Morphe ${record.morphe} · [run](${runUrl})`,
    "",
    "This issue closes itself when the app builds again.",
    "",
    `<!-- ${MARKER}${fingerprint(record)} -->`,
  )
  return lines.join("\n")
}

/** A stand-in record for a matrix leg that ended without writing one. */
export const missingRecord = (app: string): BuildRecord => ({
  app,
  status: "failed",
  reason: "the build job ended without a record (it crashed, timed out or was cancelled)",
  patches: { repo: "", tag: "", asset: "", sha256: "" },
  morphe: "",
  attempts: [],
  finishedAt: new Date().toISOString(),
})

const BuildRecordJson = Schema.fromJsonString(BuildRecord)

/**
 * Find every build.json under `dir` and match it to its app by the app it names, not
 * by its path: download-artifact unpacks a single matching artifact straight into
 * `dir` and several into `dir/<artifact>/`. An app with no readable record becomes
 * a failure, so a crashed leg is reported rather than silently skipped.
 */
export const readRecords = Effect.fn("readRecords")(function* (
  dir: string,
  apps: ReadonlyArray<string>,
) {
  const found = yield* findRecords(dir)
  return apps.map((app) => found.get(app) ?? missingRecord(app))
})

/** Every readable build.json under `dir`, by the app it names. */
export const findRecords = Effect.fn("findRecords")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const found = new Map<string, BuildRecord>()
  const files = (yield* fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.orElseSucceed(() => []))).filter((f) => path.basename(f) === "build.json")
  for (const file of files) {
    const text = yield* fs.readFileString(path.join(dir, file)).pipe(Effect.option)
    if (Option.isNone(text)) continue
    const decoded = yield* Schema.decodeEffect(BuildRecordJson)(text.value).pipe(Effect.option)
    if (Option.isSome(decoded)) found.set(decoded.value.app, decoded.value)
  }
  return found
})

/** A built app that did not make it into the release is a failure too. */
export const markUnpublished = (
  records: ReadonlyArray<BuildRecord>,
  published: ReadonlySet<string>,
): ReadonlyArray<BuildRecord> =>
  records.map((r) =>
    r.status === "built" && !published.has(r.app)
      ? {
          ...r,
          status: "failed" as const,
          reason: PUBLISH_REASON,
        }
      : r,
  )

const publishSignature = (records: ReadonlyArray<BuildRecord>): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(JSON.stringify(records.map((r) => `${r.app}@${r.version ?? "?"}`).toSorted()))
  return hasher.digest("hex").slice(0, 16)
}

export const publishIssueBody = (records: ReadonlyArray<BuildRecord>, runUrl: string): string => {
  const rows = records.map(
    (r) =>
      `| ${r.app} | ${r.version ?? "?"} | ${r.appliedPatches ?? "?"}/${r.expectedPatches ?? "?"} |`,
  )
  return [
    `Signing or publishing failed in [this run](${runUrl}); these apps were built but are not in the release, so their previous release (if any) is still what is published.`,
    "",
    "| App | Version | Patches |",
    "|---|---|---|",
    ...rows,
    "",
    "The build log is the publish job's; the usual causes are Infisical, the keystore, or GitHub's release API.",
    "This issue closes itself when a publish succeeds.",
    "",
    `<!-- ${MARKER}publish-${publishSignature(records)} -->`,
  ].join("\n")
}

export interface ReportAction {
  readonly app: string
  readonly action: "opened" | "commented" | "unchanged" | "closed" | "none"
  readonly issue?: string
}

export const report = Effect.fn("report")(function* (
  repo: string,
  allRecords: ReadonlyArray<BuildRecord>,
  runUrl: string,
  options: { readonly publishResult?: string | undefined } = {},
) {
  const actions: Array<ReportAction> = []
  const publishFailed = options.publishResult === "failure" || options.publishResult === "cancelled"
  const unpublished = allRecords.filter((r) => r.status === "failed" && r.reason === PUBLISH_REASON)
  const existingPublish = yield* GitHub.findOpenIssue(repo, PUBLISH_TITLE, LABEL)

  if (publishFailed && unpublished.length > 0) {
    // One issue for the publish failure; these apps get no per-app issue.
    const body = publishIssueBody(unpublished, runUrl)
    const sig = `${MARKER}publish-${publishSignature(unpublished)}`
    if (Option.isNone(existingPublish)) {
      const created = yield* GitHub.createIssue(repo, PUBLISH_TITLE, body, [LABEL])
      for (const r of unpublished)
        actions.push({ app: r.app, action: "opened", issue: created.html_url })
    } else {
      const texts = yield* GitHub.issueTexts(repo, existingPublish.value)
      const seen = texts.some((t) => t.includes(sig))
      if (!seen) yield* GitHub.commentIssue(repo, existingPublish.value.number, body)
      for (const r of unpublished) {
        actions.push({
          app: r.app,
          action: seen ? "unchanged" : "commented",
          issue: existingPublish.value.html_url,
        })
      }
    }
  } else if (!publishFailed && Option.isSome(existingPublish)) {
    // A publish went through: retire the publish issue.
    yield* GitHub.commentIssue(
      repo,
      existingPublish.value.number,
      `Publishing succeeded in [this run](${runUrl}).`,
    )
    yield* GitHub.closeIssue(repo, existingPublish.value.number)
    actions.push({ app: "publish", action: "closed", issue: existingPublish.value.html_url })
  }

  const records = publishFailed ? allRecords.filter((r) => !unpublished.includes(r)) : allRecords
  for (const record of records) {
    const existing = yield* GitHub.findOpenIssue(repo, issueTitle(record.app), LABEL)
    if (record.status === "built") {
      if (Option.isSome(existing)) {
        yield* GitHub.commentIssue(
          repo,
          existing.value.number,
          `Built ${record.version} in [this run](${runUrl}).`,
        )
        yield* GitHub.closeIssue(repo, existing.value.number)
        actions.push({ app: record.app, action: "closed", issue: existing.value.html_url })
      } else actions.push({ app: record.app, action: "none" })
      continue
    }
    const body = issueBody(record, runUrl)
    if (Option.isNone(existing)) {
      const created = yield* GitHub.createIssue(repo, issueTitle(record.app), body, [LABEL])
      actions.push({ app: record.app, action: "opened", issue: created.html_url })
      continue
    }
    const texts = yield* GitHub.issueTexts(repo, existing.value)
    if (texts.some((t) => t.includes(`${MARKER}${fingerprint(record)}`))) {
      actions.push({ app: record.app, action: "unchanged", issue: existing.value.html_url })
    } else {
      yield* GitHub.commentIssue(repo, existing.value.number, `The reason changed.\n\n${body}`)
      actions.push({ app: record.app, action: "commented", issue: existing.value.html_url })
    }
  }
  return actions
})

/** A Markdown summary of a run, for the workflow's step summary. */
export const summary = (
  records: ReadonlyArray<BuildRecord>,
  actions: ReadonlyArray<ReportAction>,
): string => {
  const lines = [
    "| App | Result | Version | Source | Patches | Issue |",
    "|---|---|---|---|---|---|",
  ]
  for (const r of records) {
    const a = actions.find((x) => x.app === r.app)
    const issue = a?.issue ? `[${a.action}](${a.issue})` : (a?.action ?? "")
    lines.push(
      `| ${r.app} | ${r.status === "built" ? "built" : `failed: ${escapeCell(r.reason ?? "").slice(0, 120)}`} | ${r.version ?? ""} | ${r.source ?? ""} | ${r.appliedPatches ?? ""}/${r.expectedPatches ?? ""} | ${issue} |`,
    )
  }
  return lines.join("\n")
}
