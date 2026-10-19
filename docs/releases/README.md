# Release notes

Each application version must have a matching Markdown file in this directory.
The filename must exactly match `package.json.version`, including its leading
`v`, for example `v2026.7.23.md`.

Release notes are public, user-facing content. Do not include internal engine,
component, repository, or project code names; describe their user-visible
behavior in product language instead.

When an explicit update feed is configured, the Windows packaging hook copies the trimmed Markdown body into
`latest.yml` as `releaseNotes`. HTML comments are ignored, so a file containing
only an instructional comment produces `releaseNotes: ''`.

The same hook also generates `release-history.json` from all versioned Markdown
files in this directory. Its first entry and `latestVersion` must match the
version, date, and release notes in `latest.yml`. Existing clients continue to
use only `latest.yml`; newer clients fetch the JSON history only when the user
opens release history.

Generation fails if the history exceeds the client limits defined in
`src/config/appUpdate.ts`, preventing a package that clients cannot
display.

Upload the versioned installer and `release-history.json` to the Generic update
server before atomically replacing `latest.yml`. Differential downloads are
disabled; clients download the complete installer and verify its SHA-512 value
against `latest.yml`.

The Windows Generic feed is configured in `src/config/appUpdate.ts`. Its default
is empty for offline distribution. Empty, placeholder or invalid addresses disable
update publishing and installed-app checks; packaging removes stale update YAML,
configuration markers and release manifests. An installed build requires both
its NSIS installation marker and matching valid feed/configuration metadata.
Inherited environment variables do not enable a feed.

Configured packaging does not need to reach the feed. Run
`npm run verify:windows-update-artifacts` after packaging and before uploading
any files. This also verifies that an unconfigured build contains no stale update
metadata.

The current internal distribution does not use Authenticode publisher
verification. If code signing is introduced later, configure the certificate
publisher and restore signature verification in the same release.
