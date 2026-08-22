# Test organization

Repository-level tests are grouped by the production area they cover:

- `build/`: packaging, installer, update manifest, and package-script contracts.
- `scripts/`: standalone build and resource-preparation scripts.
- `openclaw/runtime/`: OpenClaw runtime staging, verification, and launcher behavior.
- `openclaw/patches/<version>/`: patch behavior pinned to a specific OpenClaw release.

Use kebab-case `*.test.ts` filenames. Keep source-level unit tests co-located under
`src/`; add tests here only when they exercise repository scripts, packaged assets,
or integration contracts spanning multiple source domains.
