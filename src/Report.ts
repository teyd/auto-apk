/**
 * Turn build records into GitHub issues: one open issue per failing app, updated
 * only when the reason changes, closed when the app builds again.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { BuildRecord } from "./Build.ts"
import * as GitHub from "./GitHub.ts"

export const LABEL = "build-failure"
export const issueTitle = (app: string) => `Build failing: ${app}`

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

const escapeCell = (s: string) => s.replace(/\|/gu, "\\|").replace(/\n/gu, " ")

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

/** Read `<dir>/<app>/build.json` for each app; a missing or unreadable one becomes a failure. */
export const readRecords = Effect.fn("readRecords")(function* (
  dir: string,
  apps: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const records: Array<BuildRecord> = []
  for (const app of apps) {
    // Locally <dir>/<app>/build.json; downloaded artifacts land in <dir>/record-<app>/.
    const candidates = [
      path.join(dir, app, "build.json"),
      path.join(dir, `record-${app}`, "build.json"),
    ]
    let text: Option.Option<string> = Option.none()
    for (const file of candidates) {
      if (Option.isNone(text)) text = yield* fs.readFileString(file).pipe(Effect.option)
    }
    if (Option.isNone(text)) {
      records.push(missingRecord(app))
      continue
    }
    const decoded = yield* Schema.decodeEffect(BuildRecordJson)(text.value).pipe(Effect.option)
    records.push(Option.isSome(decoded) ? decoded.value : missingRecord(app))
  }
  return records
})

export interface ReportAction {
  readonly app: string
  readonly action: "opened" | "commented" | "unchanged" | "closed" | "none"
  readonly issue?: string
}

export const report = Effect.fn("report")(function* (
  repo: string,
  records: ReadonlyArray<BuildRecord>,
  runUrl: string,
) {
  const actions: Array<ReportAction> = []
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
