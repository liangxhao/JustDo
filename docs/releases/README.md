# Release notes

Each application version must have a matching Markdown file in this directory.
The filename must exactly match `package.json.version`, including its leading
`v`, for example `v2026.7.23.md`.

Release notes are public, user-facing content. Do not include internal engine,
component, repository, or project code names; describe their user-visible
behavior in product language instead.

The Windows packaging hook copies the trimmed Markdown body into
`latest.yml` as `releaseNotes`. HTML comments are ignored, so a file containing
only an instructional comment produces `releaseNotes: ''`.

Upload the versioned installer and its blockmap to the Generic
update server before atomically replacing `latest.yml`.

The Windows Generic feed is checked into
`scripts/windows-update-config.cjs`. Packaging does not need to reach the feed
and does not require update environment variables. Run
`npm run verify:windows-update-artifacts` after packaging and before uploading
any files.

The current internal distribution does not use Authenticode publisher
verification. If code signing is introduced later, configure the certificate
publisher and restore signature verification in the same release.
