# auto-apk

Scheduled [Morphe](https://github.com/MorpheApp) patch builds for 8 Android apps, published
as one rolling GitHub release that [Obtainium](https://github.com/ImranR98/Obtainium) can
track.

> [!WARNING]
> These are **unofficial, modified** builds of third-party apps. They are not affiliated with
> or endorsed by the apps' publishers or by Morphe. Patched clients can break the apps' terms
> of service and put your account at risk. Use at your own risk.

## What it builds

| App       | Patches                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| YouTube   | [MorpheApp/morphe-patches](https://github.com/MorpheApp/morphe-patches)                   |
| Reddit    | [MorpheApp/morphe-patches](https://github.com/MorpheApp/morphe-patches)                   |
| X         | [crimera/piko-newx](https://github.com/crimera/piko-newx)                                 |
| Instagram | [crimera/piko](https://github.com/crimera/piko)                                           |
| Gboard    | [jasonwu1994/Gboard-patches](https://github.com/jasonwu1994/Gboard-patches)               |
| Discord   | [VenusIsJaded/Venus-Patches](https://github.com/VenusIsJaded/Venus-Patches)               |
| TikTok    | [SysAdminDoc/HushFeed](https://github.com/SysAdminDoc/HushFeed)                           |
| Twitch    | [jordanwoodson/lurk-morphe-patches](https://github.com/jordanwoodson/lurk-morphe-patches) |

Every few hours the pipeline checks each bundle for a new release, asks Morphe which app
version it supports, downloads that exact stock version, checks it carries the publisher's
signing certificate, patches it with each bundle's default patches, signs it, and replaces
that app's file in the `latest` release. Patch options are set inside each app.

## Installing with Obtainium

Add this repository once per app, with an asset filter such as `^youtube-`. YouTube also
needs [MicroG-RE](https://github.com/MorpheApp/MicroG-RE).

## Changing what is built

Everything is in [`auto-apk.json`](auto-apk.json); your editor shows a description for
every field. To pin an app to a version, add `"version": "<version>"` to it. To stop
building one, add `"enabled": false`. Run `bun src/main.ts check` to validate.

## Development

See [AGENTS.md](AGENTS.md) for the layout, the rules and the commands, and
[PLAN.md](PLAN.md) for the design.
