# Smart Canvas

Optional bundled plugin for displaying visual content in conversations. Its
`visualize` skill routes complete HTML, interactive 3D scenes, games, simulations
and resource-dependent pages to hosted webpage cards. Existing sites embed their
URL. Compact self-contained cards and conversation draft actions use the native
`show_widget` tool. Design skills can supply source and appearance; Smart Canvas
completes the visible delivery.

The plugin registers one optional `interactive-answer` content kind for tables,
comparisons, charts, forms and expandable steps. Custom compact layouts use
native HTML/SVG directly. Complete webpages retain their ordinary HTML, assets
and loaders in the separate webpage viewer. No networking adapter, tool hook,
HTTP route, additional tool or runtime patch is registered.

## Ownership

- `ui/` owns fixed component schema, document composition, renderer, labels and styles.
- `document/` owns the shared serialization and renderer-loading helpers.
- `skills/visualize/` owns viewer selection and its on-demand authoring references.
- `tests/` owns fixed-component and resource-loading tests. Host integration and
  packaging tests stay in the application's test tree.

The local-extension pipeline copies and precompiles the plugin and its single
skill. There are no production or development npm dependencies in this plugin.
Source synchronization and packaging exclude unused source assets. It is enabled
by default; configuration preserves explicit enable/disable choices. Disabling
it does not delete native history or rewrite saved documents.

## Delivery

Start with [visualize](skills/visualize/SKILL.md). The skill applies to requests
for visuals on screen, including content already produced through another design
skill. Explicit file-only deliverables and real application development retain
their own completion criteria.

For authored pages, write files beneath the verified current Gateway profile's
`canvas/documents/<fresh-id>/`, then emit the actual `[embed ref="..."]` in
assistant text. For an existing HTTP(S) site, emit `[embed url="..."]` directly.
The shortcode needs no display tool call. See [hosted HTML](skills/visualize/references/hosted-html.md)
and [worked examples](skills/visualize/references/delivery-examples.md) for staging,
relative assets, interactive HTML and a compact Widget.

The webpage host checks the external-URL setting and follows the Browser proxy
setting, defaulting to the system proxy. External URLs share the default sidebar
browser's site login/storage. Hosted refs use an isolated temporary session and
shell/iframe. Both support expansion and sidebar presentation. Webpages have no
Widget draft bridge; ordinary CSP, CORS and target restrictions remain in force.
The skill neither changes proxy settings nor adds public resource fallbacks.

For compact cards, discover the actual native `show_widget` and its current
schema. `kind: "html"` takes a fragment string in `widget_code`. Use supplied
data, inline assets and local interaction; no library is preloaded. Native CSP
and capability checks remain authoritative. Do not add pinning or network
capabilities to adapt complete webpages. The [native HTML reference](skills/visualize/references/native-html.md)
covers resource constraints, links and the optional human-confirmed draft bridge.
A bridge receipt confirms local suggestion delivery, not model execution; the
user still sends through the normal composer.

For `kind: "interactive-answer"`, `widget_code` is a JSON string with `version`,
`language`, `summary` and `blocks`. Its schema, limits and complete examples are
in [fixed components](skills/visualize/references/fixed-components.md). The source
is capped at 64 KiB and eight blocks; unknown fields and executable content are
rejected. The native resource is `/__smart_canvas__/ui.js`, and native storage
records the kind as `smart-canvas:interactive-answer`.

| Component | Local behavior |
| --- | --- |
| table | Search, stable sorting, five-row pages and row details. |
| compare | Select options with common metrics. |
| chart | Line/bar series toggles and a source data table. |
| form | Text, numbers, selection, checkboxes and multiple selection. |
| steps | Keyboard-accessible expandable explanations. |

Local inputs survive component switches. Reloading restores the supplied defaults;
no selection store or historical document update API is added. Optional follow-up
creates a bounded, reviewable draft for the user's existing confirmation flow.

## Checks

```powershell
node node_modules/vitest/vitest.mjs run plugins/extensions/smart-canvas/tests tests/scripts/smart-canvas
& '<runtime>/node-runtime/node.exe' scripts/test/smart-canvas/verify-runtime.mjs '<runtime>'
& '<runtime>/node-runtime/node.exe' scripts/test/smart-canvas/verify-gateway.mjs '<runtime>'
```

The registrar check uses the locked runtime's native SDK. The Gateway check uses
an isolated state directory and synthetic loopback provider to verify plugin
loading, native tool schema, resources, authenticated views, history/restart and
disable. It does not use the active application Gateway or user credentials.

Additional Gateway probe modes run separately:

- `--tool-dispatch`: native HTML through Tool Search with this plugin disabled.
- `--retention`: native 32-document retention and isolation between sessions.
- `--interaction-contract`: trusted activation, immutable documents and the
  actual native private prompt bridge.
- `--interaction-contract --presentation`: real viewer/sandbox checks for fixed
  components and HTML in light/dark themes at wide and narrow card widths.

Use a freshly prepared runtime matching the current source recipe. Actual model
quality and platform coverage remain in the
[feature contract](../../../docs/features/chat/interactive-answers.md#当前验证边界).
