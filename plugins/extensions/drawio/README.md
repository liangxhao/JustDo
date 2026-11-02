# draw.io MCP App

The optional, default-enabled draw.io plugin owns its MCP tool, editor UI,
bundled assets and build tooling. It uses the standard MCP Apps protocol.
Standard rendering and exports use the generic host;
authenticated plugin RPCs provide current-canvas editing and native history recovery.

## Layout

| Path                                                | Responsibility                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `index.ts`, `openclaw.plugin.json`, `package.json`  | Thin native registration and declarative MCP server                                   |
| `server.mjs`, `editor-resource.mjs`                 | XML tool and shared immutable editor UI resources                                     |
| `restore.ts`, `restore-result.ts`, `contracts.ts`   | Authenticated recovery of an existing native diagram result                           |
| `editing.ts`, `canvas-state.ts`, `update-result.ts` | Exact-run current-canvas routing, application receipts and confirmed result selection |
| `browser/current-canvas.ts`                         | Browser-only standard AppBridge adapter and navigation cleanup                        |
| `skills/drawio-diagrams/SKILL.md`                   | Native, on-demand drawing guidance and MCP tool discovery                             |
| `app.ts`, `app.css`, `editor-bridge.js`             | Standard App UI and local editor integration                                          |
| `upstream.json`                                     | Pinned editor source and archive integrity                                            |
| `licenses/`                                         | Pinned third-party notices omitted from published dependency packages                 |
| `scripts/prepare.cjs`                               | Asset preparation, bundling and integrity verification                                |
| `scripts/verify-packaged.cjs`                       | Verification of the final installed resource layout                                   |
| `tests/`                                            | Plugin unit tests and diagram fixture                                                 |
| `assets/`                                           | Generated, ignored runtime bundles, editor resources and licenses                     |

The distributed plugin includes editor resources, layouts, workers, WASM,
formulas, shapes and notices. Upstream Java-server `WEB-INF/` and `META-INF/`
directories and source maps are excluded from the bundle.

The asset service checks OS-assigned loopback ports against Chromium/WHATWG
restrictions before publishing a resource origin or CSP. A rejected port (such
as 6000) is closed before another allocation, with at most 32 attempts. Failure
is explicit; browser restrictions are never disabled. `tests/ports.test.ts`
covers allocation and cleanup.

The manifest declares the plugin's native skill directory. Its short description
makes drawing requests discoverable without naming draw.io; the detailed guide
is loaded on demand and tells the model to search the actual MCP catalog before
calling the returned drawing tool. It does not change tool policy, force a tool
choice, inject a host prompt, or add a runtime patch. The independent plugin tool
`drawio_diagram` reads/updates an already prepared canvas; creation still uses MCP.
Disabling the plugin removes its skill from native discovery.

The App-only `open_editor` tool advertises a global entrypoint under
`_meta['openai/ui'].entrypoints`. It opens an empty graph through native App
discovery and launch, using the same bundled UI resource as `create_diagram`.
It requires no model request and stays out of the model tool catalog.
The server and tools advertise an inline SVG through native MCP `icons` metadata
for the sidebar homepage. The host does not map plugin names to bundled icons.

The App-only `open_file` tool advertises `.drawio` file entrypoints. Native launch
checks the session workspace and supplies a view-bound `openclaw-file://` resource;
the App reads its UTF-8 XML through the standard host resource bridge. The MCP
process never opens arbitrary local paths. Files are limited to 1 MiB, reject DTD
and malformed XML, and may contain compressed mxfile diagrams decoded by draw.io.
Opening leaves the source unchanged; saving uses the existing native Save dialog.

Recovery reads the latest confirmed plugin update, or the exact original child result
from the current visible native transcript through public SDK accessors, then
creates a fresh native preview using `prepareHarnessNativeMcpAppPreview`. It
never reruns the tool, imports private OpenClaw modules, accepts restore XML from Renderer or
reinstates tool grants. Local unsaved edits are not a durable transcript.

## Host boundary

The App optionally declares `experimental['ui/shared-header'] = { version: 1 }`.
When the same host-context key supplies `{ height, left, right }` in pixels, only
the top toolbar hides its duplicate title and reserves the host-owned areas.
Save/export buttons stay in the original iframe and use the existing SDK paths;
the editor canvas keeps its full width. A null or missing layout restores the
complete standalone toolbar. This presentation extension grants no permissions
and requires no knowledge of host tabs, menus or display locations.

The App exposes a read-only standard App tool with
`_meta['workspace/prepare-context'] = true` for hosts that advertise native context
updates. The desktop current-canvas host instead admits the exact native view and
its server-issued origin before mounting the iframe, then disables that legacy
context capability. Each send reads a fresh snapshot through the independently
authenticated canvas route. Model switching leaves the editor and undo stack
intact without reinstating old native App grants. The plugin service owns the
immutable editor resources and matching native sandbox/CSP independently of the
model's MCP runtime. Homepage adoption neither relaunches the editor nor copies
XML into product storage.

Current-canvas editing uses two browser tools over standard AppBridge: snapshot
commits active text and exports all pages; apply checks the content stamp and
editor generation before one undoable `replaceFileData` transaction. The host
registers immutable native identity and routes an exact prepared send through
`drawio.chat.send`. The v2 plugin tool consumes trusted native invocation metadata,
and only an exact editor ACK yields a successful native tool result. Switching
chats retires pending authority, including preparations whose response was lost;
unknown dispatches are never replayed. Recovery grants no original MCP tools.
There is no new document database or user-facing version history.

Confirmed updates also emit a bounded `drawio.diagram-reference.v1` text record
so native history can retain the title, original content source and exact call
association when custom details are filtered. Full XML remains in the existing
receipt/storage path. The host maps this reviewed integration to generic App
references; pinning keeps the original frame and permissions.

The host owns generic MCP App discovery/rendering, file downloads and native Save
dialogs. The plugin owns its drawing tools, editor UI, bundled resources and
build tooling.
