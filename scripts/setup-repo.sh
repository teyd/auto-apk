#!/usr/bin/env bash
# Apply auto-apk's GitHub and Pullfrog settings. Safe to run again: every step
# sets the desired state, so this file is also the record of what it should be.
#
# Run by you, from a clone, with your own `gh` login (admin on the repo).
# CI never runs it.
#
#   scripts/setup-repo.sh                 # repo in the current directory
#   REPO=owner/name scripts/setup-repo.sh
#   SKIP_PULLFROG=1 scripts/setup-repo.sh # before the Pullfrog app is installed
#
# Optional, once the Infisical project exists (IDs, not secrets):
#   INFISICAL_PROJECT_ID=... INFISICAL_IDENTITY_ID=... scripts/setup-repo.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
API="repos/$REPO"
step() { printf '\n== %s\n' "$*"; }
api() { gh api --silent -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

step "Repository settings ($REPO)"
api -X PATCH "$API" --input - <<'JSON'
{
  "description": "Scheduled Morphe patch builds for 8 Android apps, published as one rolling release. Unofficial.",
  "has_issues": true,
  "has_wiki": false,
  "has_projects": false,
  "has_discussions": false,
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_auto_merge": true,
  "delete_branch_on_merge": true,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
api -X PUT "$API/topics" --input - <<'JSON'
{ "names": ["android", "morphe", "patches", "obtainium", "github-actions", "effect-ts", "bun"] }
JSON

step "Actions: read-only token, full-SHA pins, approval for outside contributors"
api -X PUT "$API/actions/permissions" --input - <<'JSON'
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": true }
JSON
api -X PUT "$API/actions/permissions/workflow" --input - <<'JSON'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON
api -X PUT "$API/actions/permissions/fork-pr-contributor-approval" --input - <<'JSON'
{ "approval_policy": "all_external_contributors" }
JSON

step "Environment 'release', deployable from main only"
api -X PUT "$API/environments/release" --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
if ! gh api "$API/environments/release/deployment-branch-policies" -q '.branch_policies[].name' | grep -qx main; then
  api -X POST "$API/environments/release/deployment-branch-policies" -f name=main -f type=branch
fi

step "Ruleset 'main' from .github/rulesets/main.json"
ruleset_id=$(gh api "$API/rulesets" -q '.[] | select(.name == "main") | .id')
if [ -n "$ruleset_id" ]; then
  api -X PUT "$API/rulesets/$ruleset_id" --input .github/rulesets/main.json
else
  api -X POST "$API/rulesets" --input .github/rulesets/main.json
fi

step "Security: Dependabot alerts on, its fix PRs off (Renovate does that), private reporting, CodeQL"
api -X PUT "$API/vulnerability-alerts"
api -X DELETE "$API/automated-security-fixes" || true
api -X PUT "$API/private-vulnerability-reporting"
api -X PATCH "$API/code-scanning/default-setup" --input - <<'JSON'
{ "state": "configured", "query_suite": "default", "languages": ["actions", "javascript-typescript"] }
JSON

step "Labels"
gh label create build-failure --repo "$REPO" --force --color B60205 \
  --description "Opened by the build workflow when an app cannot be built"

if [ -n "${INFISICAL_PROJECT_ID:-}" ] && [ -n "${INFISICAL_IDENTITY_ID:-}" ]; then
  step "Repository variables for Infisical (IDs, not secrets)"
  gh variable set INFISICAL_PROJECT_ID --repo "$REPO" --body "$INFISICAL_PROJECT_ID"
  gh variable set INFISICAL_IDENTITY_ID --repo "$REPO" --body "$INFISICAL_IDENTITY_ID"
fi

if [ -n "${SKIP_PULLFROG:-}" ]; then
  printf '\nSkipping Pullfrog (SKIP_PULLFROG set).\n'
  exit 0
fi

step "Pullfrog: review only, Grok by default, no pushes, ignore strangers and bots"
pf() { npx --yes pullfrog@latest config set "$@" --repo "$REPO" --yes; }
pf review.mode agent
pf review.re-review true
pf review.non-collaborators false
pf review.drafts false
pf review.own-prs false
pf review.approve false
pf review.status-check true
pf review.approval-check false
pf auto-merge false
pf push disabled
pf shell restricted
pf mention.enabled true
pf mention.non-collaborators false
pf address-reviews.enabled false
pf fix-ci.own-prs false
pf fix-ci.reviewed-prs false
pf issue.mode none
pf issue.non-collaborators false
pf label.enabled false
pf instructions --file .github/pullfrog/instructions.md
pf prompts.review --file .github/pullfrog/review.md

cat <<'NOTE'

Done. Two Pullfrog settings are not in its CLI and are set once in the console
(pullfrog.com/console -> auto-apk -> Agent):
  - Provider: xAI (your Grok subscription)
  - Model: Smart
NOTE
