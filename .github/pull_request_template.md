## What and why

<!-- One or two sentences. The title is the squash commit: use a conventional commit title. -->

## Checklist

- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass locally
- [ ] Schema regenerated (`bun run schema`) if `src/Config.ts` changed
- [ ] No new secret reaches the `build` job; actions pinned to full SHAs
