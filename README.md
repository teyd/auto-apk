# auto-apk

Unofficial [Morphe](https://github.com/MorpheApp)-patched Android apps, built on a schedule
and published as GitHub releases. Which apps are built is set in
[`auto-apk.json`](auto-apk.json); the [`latest`](../../releases/tag/latest) release lists
the current builds.

> [!WARNING]
> Modified third-party apps, not affiliated with their publishers or Morphe. Use at your own risk.

Install with [Obtainium](https://github.com/ImranR98/Obtainium): add this repository once per
app and filter release titles by the app's id, e.g. `^youtube-`. YouTube needs
[MicroG-RE](https://github.com/MorpheApp/MicroG-RE).

Signing certificate SHA-256:
`e2bb9e9fd8596af4ead7227ac570d6ed8f38f57350c6b9c41c89161933a6f00e`. Check a download's
origin with `gh attestation verify <file>.apk --repo teyd/auto-apk`.

Development: [AGENTS.md](AGENTS.md).
