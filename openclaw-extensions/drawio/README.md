# draw.io MCP App

The optional, default-enabled draw.io plugin owns its MCP tool, editor UI, offline
assets and build tooling. It uses the standard MCP Apps protocol and does not
import application `src`. Standard rendering and exports use the generic host;
a read-only recovery RPC covers the native ToolSearch reconstruction gap.

## Layout

| Path                                               | Responsibility                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `index.ts`, `openclaw.plugin.json`, `package.json` | Thin native registration and declarative MCP server                   |
| `server.mjs`, `editor-resource.mjs`                | XML tool and shared immutable offline UI resources                    |
| `restore.ts`, `restore-result.ts`, `contracts.ts`  | Authenticated recovery of an existing native diagram result           |
| `skills/drawio-diagrams/SKILL.md`                  | Native, on-demand drawing guidance and MCP tool discovery             |
| `app.ts`, `app.css`, `editor-bridge.js`            | Standard App UI and local editor integration                          |
| `upstream.json`                                    | Pinned editor source and archive integrity                            |
| `licenses/`                                        | Pinned third-party notices omitted from published dependency packages |
| `scripts/prepare.cjs`                              | Offline asset preparation, bundling and integrity verification        |
| `scripts/verify-packaged.cjs`                      | Verification of the final installed resource layout                   |
| `tests/`                                           | Plugin unit tests and diagram fixture                                 |
| `assets/`                                          | Generated, ignored runtime bundles, editor resources and licenses     |

Preparation inputs and commands are maintained in
[offline downloads](../../docs/offline-downloads.md#5-drawio-离线编辑器).
Root `drawio:prepare` / `drawio:verify` commands delegate to this plugin's scripts;
the plugin package also exposes `assets:prepare` / `assets:verify`. Build tooling
uses the repository's installed development dependencies; generated bundles need
no npm installation at runtime.

Preparation excludes the upstream Java-server `WEB-INF/` and `META-INF/`
directories and source maps. Browser editor resources, layouts, workers, WASM,
formulas, shapes and notices remain bundled. Filtering happens before the
integrity manifest is generated; packaging must preserve that closed set.

The asset service checks OS-assigned loopback ports against Chromium/WHATWG
restrictions before publishing a resource origin or CSP. A rejected port (such
as 6000) is closed before another allocation, with at most 32 attempts. Failure
is explicit; browser restrictions are never disabled. `tests/ports.test.ts`
covers allocation and cleanup, and the host's offline smoke probe accepts
`--unsafe-port` to exercise a real blocked first allocation in Chromium.

The manifest declares the plugin's native skill directory. Its short description
makes drawing requests discoverable without naming draw.io; the detailed guide
is loaded on demand and tells the model to search the actual MCP catalog before
calling the returned drawing tool. It does not change tool policy, force a tool
choice, inject a host prompt, register another tool, or add a runtime patch.
Disabling the plugin removes its skill from native discovery.

The App-only `open_editor` tool advertises a global entrypoint under
`_meta['openai/ui'].entrypoints`. It opens an empty graph through native App
discovery and launch, using the same offline resource as `create_diagram`.
It requires no model request and stays out of the model tool catalog.
The server and tools advertise an inline SVG through native MCP `icons` metadata
for the sidebar homepage. The host does not map plugin names to bundled icons.

The App-only `open_file` tool advertises `.drawio` file entrypoints. Native launch
checks the session workspace and supplies a view-bound `openclaw-file://` resource;
the App reads its UTF-8 XML through the standard host resource bridge. The MCP
process never opens arbitrary local paths. Files are limited to 1 MiB, reject DTD
and malformed XML, and may contain compressed mxfile diagrams decoded by draw.io.
Opening leaves the source unchanged; saving uses the existing native Save dialog.

Recovery runs only after native view expiration. It reads the exact child result
from the current visible native transcript through public SDK accessors, then
creates a fresh native preview using `prepareHarnessNativeMcpAppPreview`. It
never reruns the tool, imports private OpenClaw modules, reads Renderer XML or
reinstates tool grants. Local unsaved edits are not a durable transcript.

## Host boundary

The host owns generic MCP App discovery/rendering, file downloads and native Save
dialogs. Default enablement, runtime fingerprinting and packaging retain thin
integration calls/declarations in the host. End-to-end host/runtime/package probes
remain in `tests/drawio/`; they are not plugin runtime dependencies.

Follow the same ownership for future plugins: keep each tool, UI, resources and
build logic together, and reuse the standard host capabilities. Product-facing
behavior and offline constraints are documented in
[offline diagrams](../../docs/features/chat/drawio-offline.md).
