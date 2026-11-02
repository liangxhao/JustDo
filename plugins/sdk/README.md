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

## Distribution

Prepare compatible public SDK and build-tool packages on a machine with the
repository dependencies installed:

```sh
npm run plugins:app:sdk
npm run plugins:runtime:sdk
node -e "require('node:fs').mkdirSync('cache/app-plugin-packages', { recursive: true })"
npm pack ./build/app-plugin-sdk --pack-destination cache/app-plugin-packages
npm pack ./build/runtime-services-sdk --pack-destination cache/app-plugin-packages
npm pack ./plugins/sdk/app-plugin-build --pack-destination cache/app-plugin-packages
```

Package filenames follow their metadata. Publish these archives to the configured
internal npm registry, or install explicit local tarballs in the external project
and update its dependency lockfile. These are locally generated distribution
artifacts rather than files to download for application startup or EXE packaging.
