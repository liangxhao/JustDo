# App plugin build tools

`@app-plugin/build` builds a native OpenClaw extension and its trusted desktop app
companion. This is a separate protocol from MCP Apps. Use Node 24 and explicitly
install this package, a compatible `@app-plugin/sdk`, the plugin's declared npm
dependencies, and matching public OpenClaw declarations. No application checkout,
theme source, sibling plugin source, or runtime download is used.

```sh
app-plugin-build check --source plugins/extensions/example --sdk-root /prepared/openclaw/dist/plugin-sdk
app-plugin-build build --source plugins/extensions/example --out build/app-plugins
```

`--source-root plugins/extensions` builds or checks an inventory instead. An
existing empty inventory produces `catalog.json` containing `[]`; malformed
packages and missing declared entries fail. `OPENCLAW_SDK_ROOT` supplies the same
explicit declaration input as `--sdk-root`; otherwise normal installed public
OpenClaw exports are used. Installation does not prove that the runtime provides
the execution capabilities required by a particular plugin.

The source package declares `openclaw.extensions`, `app.main`, `app.browser`, and
optional `app.presentation`. `app.plugin.json` uses SDK v1 and must match its
package version and native ID. Dependencies are resolved through installed npm
exports, including npm workspaces during development. Relative imports cannot
escape the plugin or its installed dependencies. Published builds must be checked
using real installed tarballs, without workspace links.

The output retains the existing `single-file-v1` native profile, native binding,
content hash, and companion artifact manifest. `packages/<id>/<hash>` is the
complete installable extension, including `index.js`, native metadata, declared
skills, and `app/`. Do not copy only the UI or rename the bound native entry.
The package also carries its own LICENSE and license files plus versions for
dependencies actually bundled. Supply a LICENSE in the source package; missing
dependency licenses fail the build. npm install hooks and bundled dependency
declarations are removed from the delivered package.
Native dependencies are bundled except permitted Node built-ins and literal
public `openclaw/plugin-sdk/*` imports. Main dependencies are bundled. Browser
React/ReactDOM use the host's SDK v1 singleton. Pure presentation modules cannot
import that runtime. No installation or SDK copying occurs at plugin startup.

The public `@app-plugin/build/theme-preset` exports the shared Tailwind v3 theme.
Plugin utilities omit preflight and remain scoped to their plugin style boundary.
Its existing CSS token names are compatibility contracts supplied by the app
host; the preset does not inspect the host's private theme files. Explicitly
configure the SDK runtime and theme tokens in standalone browser tests.

`@app-plugin/build/testing` exports `installBrowserRuntime(runtime)`, which installs
caller-supplied public SDK ports before importing a plugin and returns a disposer.
It provides no application mocks, chat controller, i18n implementation, history
cache, or authorization. Business tests supply the ports they use. Real host
integration is a separate, explicitly configured test profile.

`@app-plugin/build/sdk` exports `buildSdkPackage({source, destination, licenseFile})`
for publishing a flat TypeScript SDK as ESM, declarations, portable exports,
README, and LICENSE. This is an authoring tool; consuming plugins use the installed
package exports rather than source aliases.
