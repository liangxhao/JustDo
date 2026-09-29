# TypeSafe upstream source

This directory vendors `extensions/typesafe` from
`https://github.com/openclaw/openclaw`, revision
`eb377ac59e6c9fd6c7705028034812becf00271b` (package version `2026.9.6`).
The native decision semantics, response validation, skill, assets and MIT license
are preserved. One application transport seam adds `serviceUrl`: an authenticated
HTTP(S) API base including `/v1` or another prefix. It accepts explicit intranet
origins, sends prepared Bearer credentials, disables redirects/environment proxies
and never falls back to hosted Jev. It reuses native local normalization for Kev
latency metadata and score criteria. The legacy loopback-only `baseUrl` remains
unchanged; setting both endpoints is rejected. Changes touch config, client,
transport, manifest and focused tests.

Credential reflection detection checks unexpected provider model names after
native response validation. Request-owned answer IDs, labels, score legends and
the exact selected model cannot introduce a new credential disclosure; searching
the whole serialized response falsely rejected short keys matching those values,
JSON field names or numeric results. Unexpected model names containing the key
remain rejected, and raw transport diagnostics never cross the plugin boundary.

Packaging-only changes:

- Mark the package private and remove the monorepo-only `workspace:*` development
  SDK dependency. The packaged host supplies the OpenClaw SDK.
- Add an npm lockfile for the upstream `typebox@1.3.30` production dependency.
- Use the application's existing local-extension assembly and precompilation
  pipeline. Retain this plugin's and its dependencies' license files when pruning.

The application defaults this extension off, admits its optional evaluation tool
when enabled, and writes a file SecretRef for the credential. Settings → Models additionally selects the native default
`decisionModel` and manages activation when configured. See `docs/features/jev-integration.md` in the app repo.

Refresh from a reviewed upstream revision, retaining native SDK ownership. Do
not copy a developer's configured plugin directory or credentials into this tree.
