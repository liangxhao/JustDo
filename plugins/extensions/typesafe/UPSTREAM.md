# TypeSafe upstream source

This directory vendors `extensions/typesafe` from
`https://github.com/openclaw/openclaw`, revision
`157d8c2bc3ea2fa183afdc11088e69690bf8e64e` (tag `v2026.10.7`, package
version `2026.10.7`). The complete 10.6-to-10.7 directory comparison contains
only package version, minimum plugin API and build metadata changes; source,
manifest, dependencies and public SDK exports are unchanged. The local fork's
transport and credential protections below are retained, with unchanged
dependency integrities. The preceding 10.6 refresh compared upstream baseline
`383c124cc32ffee3f8e56f549b88da94d269a4af` (`2026.10.4`) and this local fork.
The native decision semantics, response validation, assets and MIT license
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

The v2026.10.4 refresh carries the native `context.isAdmissible` callback through
the decision adapter and client to the transport. Admission is checked before
guarded-fetch preparation and again by native `beforeRequest` after asynchronous
DNS/transport preparation, immediately before dispatch. This applies to hosted,
loopback and authenticated `serviceUrl` requests. It also adopts upstream's
`URL.parse` validation for the loopback origin. The native credential ownership,
lazy loading, cancellation, response cleanup and host-selected `decisionModel`
remain intact. Existing behavior tests are retained instead of importing
upstream test deletions; additional offline regressions exercise admission
revocation during lazy loading and native DNS preparation.

The v2026.10.6 refresh additionally classifies HTTP 400 alongside 413/422 as
ordinary unsupported input. Registration and transport regressions verify that
these responses do not retry, read potentially secret-reflecting error bodies,
or expose provider details. Authentication, rate limits, cancellation and
unknown transport failures retain their separate outcomes.

Packaging-only changes:

- Mark the package private and remove the monorepo-only `workspace:*` development
  SDK dependency. The packaged host supplies the OpenClaw SDK.
- Add an npm lockfile for the upstream `typebox@1.3.34` production dependency.
- Use the application's existing local-extension assembly and precompilation
  pipeline. Retain this plugin's and its dependencies' license files when pruning.

The application defaults this extension off, admits the native core decision_evaluate tool
when enabled, and writes a file SecretRef for the credential. Settings → Models additionally selects the native default
`decisionModel` and manages activation when configured. See `docs/features/models/jev-integration.md` in the app repo.

Refresh from a reviewed upstream revision, retaining native SDK ownership. The upstream plugin no longer ships a separate tool or skill; the host-selected decisionModel owns evaluation model choice. Do
not copy a developer's configured plugin directory or credentials into this tree.
