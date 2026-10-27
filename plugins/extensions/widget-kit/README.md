# Widget Kit

Optional bundled plugin for native OpenClaw `show_widget`. Its general
`visualize` skill delivers content into the current conversation, choosing
between native Widgets and webpage cards. It reuses existing designs and source;
visual design remains with design skills. Native Widgets
support local content and admitted anonymous HTTPS resource/data downloads;
existing webpage URLs and ordinary webpage behavior use a separate, actually
available host delivery path. Controls and conversation follow-up are optional.
The optional `interactive-answer` content kind provides reusable tables,
comparisons, charts, forms and expandable steps when those controls fit.
Custom layouts and calculations use the native HTML kind directly. The
`html-page` kind accepts raw fragments or complete HTML pages and adapts HTTPS
image loaders to native data URLs. Libraries load from author-supplied CDN URLs
through the browser proxy under native resource rules.
Existing webpage URLs are embedded through assistant-message syntax without an
extra tool. Authored hosted pages use the current Gateway profile's
`canvas/documents` directory. No agent tools, RPC handlers, database or runtime
patches are added; one exact capability HTTP route serves the plugin image adapter.

## Ownership and packaging

- `ui/` owns the fixed component schema, document composition, renderer,
  translated labels and styles.
- `document/` owns safe HTML/JSON serialization, document-shell adaptation,
  HTTPS image loading and resource initialization.
- `document/content-kind.ts` owns raw HTML validation and composition; its
  image adapter is generated from source and served by `document/http-route.ts`.
- `skills/visualize/` owns the general skill and its on-demand references.
- `tests/` owns component/resource-loading tests, optional browser validation and
  its local test-only Three fixture. Host integration and
  packaging tests remain in the application's test tree.

The generic local-extension pipeline copies and precompiles this plugin and
its single skill. The plugin is enabled by default; configuration preserves
explicit enable and disable choices. It adds no per-turn prompt hook.

## Application integration

The native widget viewer lives in
`src/renderer/libs/openclaw-chat/components/native-widget/`. OpenClaw owns widget
admission, wrapping, immutable documents and history. The application owns
presentation and the review/add-to-draft/send flow. Local controls do not call
the model. A bridge receipt confirms suggestion delivery, not model acceptance
or task execution.

## Authoring contract

Start with [the visualize skill](skills/visualize/SKILL.md) to choose delivery.
Its discovery description covers requests to draw or interact directly in the
current chat/app UI, including globes/3D scenes; it does not require the user to
name `show_widget`. A design skill may supply the visual/source, but an on-screen
request still needs the actual viewer handoff. See [delivery examples](skills/visualize/references/delivery-examples.md)
for Widget arguments, existing URL embeds and staged HTML refs. Explicit file
deliverables and real application development keep their own completion criteria.
The following tool rules apply to the native Widget branch. Discover the
actual native tool and use only advertised kinds. Inline availability requires
the originating viewer capability; enabling this plugin does not grant it to a
headless client. Use the real tool result instead of inventing embed handles,
Canvas IDs or native state files.

The [hosted HTML reference](skills/visualize/references/hosted-html.md) distinguishes
independent webpages from native local and network-enabled Widgets. Authored
visualizations with supported anonymous HTTPS GET/HEAD data or images can use
`html`/`html-page` with native `pin`/`netOrigins` admission. Networking or a full
HTML document alone does not require independent embedding. Existing webpage
URLs, source-site login/Cookies, network forms, WebSocket or services outside
the Widget download policy require an actually supported webpage path.
The desktop host implements independent webpage embedding and checks the current
external-URL setting when admitting a page. The hosted HTML reference explains
how to obtain the real profile directory through existing authorized host tools.
Unsupported delivery falls back to actual links or authorized file previews.
The viewer follows browserProxy, defaulting to system proxy. External URLs use a
top-level webview without preload and share the default built-in browser's site
login/storage; hosted refs retain an isolated temporary session and shell/iframe.
Other profiles and Chrome are not automatically shared. The skill does not
configure proxies or relax native Widget CSP.

For native `kind: "html"`, `widget_code` is an HTML/SVG fragment with optional
inline CSS and JavaScript. A static diagram or chart can be the complete result;
no input, button or message bridge is required. The
[HTML reference](skills/visualize/references/native-html.md)
covers resource restrictions, responsive layout, local state and the optional
draft bridge. Ordinary local widgets work without public Internet access.
Additional scripts, ES modules, stylesheets and fonts follow native CDN CSP,
without an extra `netOrigins` declaration. For fetch/XHR images or data, use the
[network-download reference](skills/visualize/references/pinned-network.md).
It uses native `pin: true` and exact `capabilities.netOrigins`, presented in the
same chat position. The browser system-proxy path downloads anonymous resources;
no visualization libraries or texture catalogs are bundled. No internal asset server
or global asset-source settings are required.

For `kind: "html-page"`, `widget_code` is the original nonempty HTML string,
including fragments or full documents. No JSON envelope or library list is needed.
The parser removes shell tags, restores html/body attributes and preserves script,
style and import-map bytes in source order. Keep an existing page's own CDN imports
without adding another library version or editing the original file.

The plugin loads its small `/__widget_kit__/image-loading.js` before author code.
HTTPS `image.src`, `setAttribute('src', ...)` and static authored `<img src>` use
native fetch, then FileReader data URLs. Three.js TextureLoader keeps original URLs
and callbacks, including detached images and source replacement races. Native
grants, CORS and proxy policy apply; no extra domain, size or timeout policy is
introduced. CSS backgrounds, posters, `srcset` and namespace writes retain native
behavior. No library globals, model loaders or decoders are preloaded.

Native content-kind registration requires at least one resource and board frame
admission requires its connection-scoped surface. The real adapter therefore uses
one `widget-html` capability route, exact match, plugin auth and native nodeCapability.
Gateway validates the capability and rewrites it to the fixed path with `oc_cap`;
the handler serves GET/HEAD only. This is plugin integration code generated from
source, without an asset directory or browser-library preparation. The viewer
refreshes this single resource surface before a new run; ticket renewal does not
restart an existing document.

A `before_tool_call` hook matches only `show_widget` and this plugin's `html-page`.
For source containing explicit HTTPS URLs, it fills omitted `pin` and exact
`netOrigins` so the call reaches native network admission. Explicit declarations
and `pin: false` stay unchanged; dynamic hosts need declared origins. The source
is preserved, and native policy still decides the grant.

Source synchronization and final packaging exclude the unused `assets` directory;
source caches are left intact. Native saved widgets cannot change registered
content kind under the same name; generate a new widget when changing kinds.

The HTML parser and entity decoder remain locked production dependencies, bundled
into the precompiled plugin with their legal notices. The installed application
runs no npm installation. Build preparation and optional test inputs are maintained
in [offline downloads](../../../docs/offline-downloads.md).

For the optional fixed `kind: "interactive-answer"`, `widget_code` is a JSON
string with `version`, `language`, `summary` and `blocks`. The complete schema,
limits and working calls are maintained in the
[fixed-component reference](skills/visualize/references/fixed-components.md).
The source is capped at 64 KiB and eight blocks; unknown fields and executable
content are rejected. The native resource is `/__widget_kit__/ui.js`.

| Component | Local behavior                                                                 |
| --------- | ------------------------------------------------------------------------------ |
| table     | Search all supplied rows, stable sorting, five-row pages and full-row details. |
| compare   | Select among options with common metrics.                                      |
| chart     | Line/bar series toggles, negative values, zero line and the source data table. |
| form      | Multiline text, numbers, single selection, checkboxes and multiple selection.  |
| steps     | Keyboard-accessible expandable explanations.                                   |

A `multiselect` field presents labeled checkboxes with up to 12 unique options.
Its initial `value` is an array of selected option strings; `required: true`
requires at least one choice before follow-up. Choices survive panel switches
and appear as per-option yes/no values in the readable draft. Complete values
remain locally available when the bounded 3600-character draft omits or shortens
entries. Reloading restores the original defaults; no selection store is added.

The plugin ID and content-kind ID are independent. Native storage records
`widget-kit:interactive-answer`. The `visualize` skill is broader than this content kind;
its guidance does not require the fixed renderer.

## Authoring references

The general skill is adapted to this application's actual native contract,
CDN resources and explicit public-resource downloads. Reviewed examples
and documentation include:

- [OpenClaw show_widget](https://docs.openclaw.ai/tools/show-widget) and its bundled
  [visualize skill](https://github.com/openclaw/openclaw/blob/main/skills/visualize/SKILL.md):
  native source, presentation and local interaction. The locked local source is
  authoritative when newer public documentation differs.
- [Claude frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)
  and [web-artifacts-builder](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/SKILL.md):
  task-led visual design and self-contained HTML. Their build stack and artifact
  delivery protocol are not requirements of this host.
- [Codex skill authoring](https://learn.chatgpt.com/docs/build-skills) and
  [OpenAI UI integration](https://developers.openai.com/plugins/build/chatgpt-ui):
  on-demand references and explicit host capabilities. MCP Apps and ChatGPT
  bridges are separate from this native widget bridge.
- [Hermes deliverable mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/deliverable-mode):
  file delivery as an alternative surface, not an interchangeable inline API.

Marketplace discovery included [ClawHub](https://clawhub.ai/) and
[skills.sh's web-artifacts-builder entry](https://skills.sh/anthropics/skills/web-artifacts-builder),
with implementation details checked against their upstream sources. No external
skills, framework dependencies or runtime services are installed by this skill.

## Checks

```powershell
node node_modules/vitest/vitest.mjs run plugins/extensions/widget-kit/tests tests/scripts/widget-kit
& '<runtime>/node-runtime/node.exe' scripts/test/widget-kit/verify-runtime.mjs '<runtime>'
& '<runtime>/node-runtime/node.exe' scripts/test/widget-kit/verify-gateway.mjs '<runtime>'
& '<runtime>/node-runtime/node.exe' scripts/test/widget-kit/verify-gateway.mjs '<runtime>' --html-page
node plugins/extensions/widget-kit/tests/verify-image-loading.cjs --runtime '<runtime>/dist'
```

The image-loading probe reads a locked local Three archive only as test input,
never as a product library. Archive locations and optional preparation are in the
offline-downloads document above. The probe uses the selected native SDK's real wrapper and both CSP
layers, a fresh Electron session, local HTTPS origins and a CONNECT proxy. It
covers four TextureLoader images, actual WebGL pixels, complete HTML and fragments with real CDN Three.js ESM imports, static images, errors, source
replacement races and denied fetch without a grant. A local OpenSSL executable
is required (`WIDGET_FIXTURE_OPENSSL` selects it). Certificate trust is limited to
the test window, fixture origins and the per-run certificate fingerprint. This
plugin/browser contract check does not launch Gateway or exercise the Main guest
controller; it does not establish reachability of an arbitrary public CDN page.

The pinned network boundary probe uses the selected artifact's bundled Node:

```powershell
& '<runtime>/node-runtime/node.exe' scripts/test/widget-kit/verify-pinned-network.mjs '<runtime>' --browser
& '<runtime>/node-runtime/node.exe' scripts/test/widget-kit/verify-pinned-network.mjs '<runtime>' --development-viewer
```

`--browser` additionally needs a local OpenSSL executable (`WIDGET_FIXTURE_OPENSSL`
can select it) to create a disposable certificate. The Electron child trusts only
the fixture hostnames and certificate fingerprint. It uses the actual Main guest
controller, minimum preload and fixed viewer with native double CSP, four HTTPS
textures, a loopback CONNECT proxy, WebGL readback, native CDN script/module/style/font
loading without extra netOrigins, and rejected upload/credential/unsupported-script/
direct-image attempts. No user Gateway, state or public source is
used. The fixture is removed after its owners close.

`--development-viewer` includes the browser checks and serves the actual viewer
through an isolated Vite-only server with the React plugin and a fixture-local
cache. It verifies the seven viewer modules and fixed Vite client/refresh/env
resources under the development transport policy, then runs the same texture
and rejection checks. It does not load the application's Vite/Electron launch
configuration or start the user's application.

The probe requires the current frozen runtime and its full artifact/recipe check.
Real system-proxy deployment and public-source CORS require target-environment acceptance.

The registrar check uses the locked runtime's native SDK. The Gateway check uses
an isolated state directory and synthetic loopback provider, covering actual
plugin loading, tool availability, public resources, authenticated views,
history/restart and disable. It does not use the application's active Gateway,
configuration, credentials or model endpoint.

`--html-page` verifies raw HTML admission, the single public image adapter,
authenticated history/restart and withdrawal after disable. Run it separately
from other Gateway scenarios. The browser verifier accepts `--runtime` pointing
to the locked runtime's `dist` directory and uses the actual native sandbox/CSP
with a fresh hidden Electron session, blocked public networking and synthetic
documents. It checks real Three.js CDN imports, image decoding/WebGL rendering,
source replacement races and permission failures; reports and screenshots stay
under `build/widget-kit/`.

- `--tool-dispatch` tests native HTML through Tool Search with this plugin disabled.
  Run it separately from component, retention and interaction checks.
- `--retention` creates 33 widgets in one synthetic session to verify the native
  32-document retention cap and isolation from another session.
- `--interaction-contract` checks rejected hidden sends, immutable inline
  documents, trusted activation and the actual native private prompt bridge.
- `--interaction-contract --presentation` additionally checks the real viewer
  and sandbox with fixed components and HTML in light/dark themes at 840/312px
  card widths. It includes multi-selection in the form and readable host draft.

Component navigation preserves inputs. Secondary data/details start collapsed;
follow-up validates inputs in place and uses the host's existing confirmation.
Actual model quality and packaged/platform coverage remain in the
[feature contract and current validation limits](../../../docs/features/chat/interactive-answers.md#当前验证边界).
