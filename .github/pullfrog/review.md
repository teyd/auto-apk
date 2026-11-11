Review for defects. This repository builds patched Android apps and publishes them
for people to install, so the security boundaries below matter more than style.

Treat any of these as a defect, at high severity:

- Anything that lets the `build` job, a patch bundle, a downloaded APK, or code that
  handles them reach the signing keystore, the release, or an `id-token`.
  Only the `publish` job, in environment `release`, may read signing secrets.
- Workflow changes: wider `permissions:`, a new `id-token: write`, an action not pinned
  to a full commit SHA, `pull_request_target`, or `${{ }}` expressions used inside `run:`
  (script injection).
- Weakening the certificate pin check: every downloaded APK and split must carry the
  app's `signature` among its signers.
- Weakening the patch-count gate: a build must fail unless Morphe applied exactly the
  number of patches `list-versions` reported. Morphe exits 0 with `success: true` and
  0 patches on an unsupported version.
- Code outside `src/Morphe.ts` that runs the Morphe jar.

For a change to `auto-apk.json`, state which pins, hashes or tool versions changed.
