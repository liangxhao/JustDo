# Widget Kit

Optional bundled plugin for native OpenClaw `show_widget`. Its general
`visualize` skill guides static visualizations, HTML/SVG explanations and
interactive tools. Controls and conversation follow-up are optional.
The optional `interactive-answer` content kind provides reusable tables,
comparisons, charts, forms and expandable steps when those controls fit.
Custom layouts and calculations use the native HTML kind directly.
No tools, RPC handlers, database or runtime patches are added.

## Ownership and packaging

- `ui/` owns the fixed component schema, document composition, renderer,
  translated labels and styles.
- `document/` owns safe HTML/JSON serialization and resource initialization.
- `skills/visualize/` owns the general skill and its on-demand references.
- `tests/` owns component and resource-loading unit tests. Host integration and
  packaging tests remain in the application's test tree.

The generic local-extension pipeline copies and precompiles this plugin and
its single skill. The plugin is enabled by default; configuration preserves
explicit enable and disable choices. It adds no per-turn prompt hook.
The plugin ID is now `widget-kit`; the directory and package name follow it.
Runtime assembly removes the former `interactive-ui` bundle only after matching
its package and manifest identities. Development startup applies the same
retirement after the replacement is present, without following directory links.
The new ID defaults to enabled; the previous ID's toggle is not transferred.
Native cards referencing the former resources need regeneration through `show_widget`.
The team calculator, its registration and its resource are removed. Existing
native history is not deleted or rewritten; retired calculator cards need to be
regenerated using a supported widget.

## Application integration

The native widget viewer lives in
`src/renderer/libs/openclaw-chat/components/native-widget/`. OpenClaw owns widget
admission, wrapping, immutable documents and history. The application owns
presentation and the review/add-to-draft/send flow. Local controls do not call
the model. A bridge receipt confirms suggestion delivery, not model acceptance
or task execution.

## Authoring contract

Start with [the visualize skill](skills/visualize/SKILL.md). Discover the
actual native tool and use only advertised kinds. Inline availability requires
the originating viewer capability; enabling this plugin does not grant it to a
headless client. Use the real tool result instead of inventing embed handles,
Canvas IDs or native state files.

For native `kind: "html"`, `widget_code` is an HTML/SVG fragment with optional
inline CSS and JavaScript. A static diagram or chart can be the complete result;
no input, button or message bridge is required. The
[HTML reference](skills/visualize/references/native-html.md)
covers resource restrictions, responsive layout, local state and the optional
draft bridge. Generated widgets must work without public Internet access.

For the optional fixed `kind: "interactive-answer"`, `widget_code` is a JSON
string with `version`, `language`, `summary` and `blocks`. The complete schema,
limits and working calls are maintained in the
[fixed-component reference](skills/visualize/references/fixed-components.md).
The source is capped at 64 KiB and eight blocks; unknown fields and executable
content are rejected. The native resource is `/__widget_kit__/ui.js`.

| Component | Local behavior |
| --- | --- |
| table | Search all supplied rows, stable sorting, five-row pages and full-row details. |
| compare | Select among options with common metrics. |
| chart | Line/bar series toggles, negative values, zero line and the source data table. |
| form | Multiline text, numbers, single selection, checkboxes and multiple selection. |
| steps | Keyboard-accessible expandable explanations. |

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

The general skill is adapted to this application's actual native contract and
offline deployment. Reviewed examples and documentation include:

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
node scripts/test/widget-kit/verify-runtime.mjs
node scripts/test/widget-kit/verify-gateway.mjs
```

The registrar check uses the locked runtime's native SDK. The Gateway check uses
an isolated state directory and synthetic loopback provider, covering actual
plugin loading, tool availability, public resources, authenticated views,
history/restart and disable. It does not use the application's active Gateway,
configuration, credentials or model endpoint.

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
[feature contract](../../../docs/features/chat/interactive-answers.md) and
[pending acceptance checks](../../../docs/plans/interactive-answers-acceptance.md).
