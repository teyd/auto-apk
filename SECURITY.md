# Security

Report a vulnerability privately through GitHub: **Security → Report a vulnerability**
on this repository. Please do not open a public issue for it.

Most relevant here:

- anything that could let code handling downloads or patch bundles reach the signing key
  or the release;
- a way to get an APK published that does not carry the publisher's pinned certificate,
  or that Morphe did not fully patch;
- workflow weaknesses (token permissions, injection, unpinned actions).

The APKs published here are unofficial builds. This covers this repository's code and
workflows, not the upstream apps or the third-party patch bundles.
