# Plugin SDK development packages

This directory contains application-owned SDK and build-tool source packages.

| Directory | npm package | Purpose |
| --- | --- | --- |
| [app-plugin-sdk](app-plugin-sdk/README.md) | `@app-plugin/sdk` | Public Native, Main, Browser and presentation contracts |
| [app-plugin-build](app-plugin-build/README.md) | `@app-plugin/build` | Standalone type checking, packaging, theme and test support |

The repository root includes `plugins/sdk/*` in its npm workspaces. Native plugin
discovery remains under `plugins/extensions/`; these development packages are
consumed through npm exports.

`npm run plugins:app:sdk` emits the App SDK to `build/app-plugin-sdk/`. Runtime
Services owns its separate client package under `plugins/extensions/runtime-services/sdk/`,
emitted by `npm run plugins:runtime:sdk`. Standalone plugin repositories install
packed SDK and build-tool releases without application source aliases.

Artifact preparation and offline distribution commands are maintained in the
[offline dependency guide](../../docs/offline-downloads.md).
