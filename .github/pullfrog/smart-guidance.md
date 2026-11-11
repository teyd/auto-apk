Use Deep only when the diff touches src/Verify.ts, src/Sign.ts, src/Sources.ts,
src/Morphe.ts, src/Release.ts, .github/workflows/, .env.schema or
scripts/create-signing-key.sh.

Use Minimal when the diff only touches docs (`*.md`), tests, schema/ regeneration,
version or hash bumps in auto-apk.json, or lockfile and dependency bumps.

Use Light or Standard for everything else, by size of the diff.
