# TypeSafe upstream source

This directory vendors `extensions/typesafe` from
`https://github.com/openclaw/openclaw`, revision
`eb377ac59e6c9fd6c7705028034812becf00271b` (package version `2026.9.6`).
The upstream implementation, manifest, skill, assets, tests, and MIT license are
preserved. No decision or transport behavior is patched by the application.

Packaging-only changes:

- Mark the package private and remove the monorepo-only `workspace:*` development
  SDK dependency. The packaged host supplies the OpenClaw SDK.
- Add an npm lockfile for the upstream `typebox@1.3.30` production dependency.
- Use the application's existing local-extension assembly and precompilation
  pipeline. Retain this plugin's and its dependencies' license files when pruning.

The application defaults this extension off, admits its optional evaluation tool
when enabled, and writes a file SecretRef for the credential. It does not select
an agent `decisionModel`. See `docs/features/jev-integration.md` in the app repo.

Refresh from a reviewed upstream revision, retaining native SDK ownership. Do
not copy a developer's configured plugin directory or credentials into this tree.
