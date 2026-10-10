# Interactive UI

Optional bundled plugin for native OpenClaw `show_widget`. It registers
`scenario-explorer` and `interactive-answer`, validates versioned JSON and composes fixed
local renderers. The former supplies a documented team calculator; the latter
combines tables, comparisons, charts, forms and expandable explanations.
No tools, RPC handlers, database or runtime patches are added.

Each content kind owns its schema, composer, runtime, labels and styles in
`scenario/` or `ui/`. Shared HTML/JSON serialization and resource initialization
live in `document/`; neither content kind depends on the other kind's schema.
The root entry retains native registration and the existing packaging contract.

The generic local-extension packaging pipeline copies and precompiles this
plugin and its on-demand `scenario-explorer` and `interactive-answer` skills. It is **disabled by
default**; app configuration preserves both explicit enable and disable choices.
It supplies no per-turn prompt hook. Actual loading and native document creation
have been tested against the locked 2026.9.8 Gateway in an isolated fixture.

## Application integration

The application uses the native widget viewer in
`src/renderer/libs/openclaw-chat/components/native-widget/` and the existing chat integration.
Suggestions use only the canonical native private prompt bridge and require
the user's confirmation before appending to the composer. Independent preview
pages, simulated draft receipts and their launch commands are not shipped.

## Authoring contract

Only call native `show_widget` when the current turn's tool schema advertises
the requested kind. Native admission requires an originating UI client with
`inline-widgets`; enabling the plugin alone does not add that capability to a
headless client. Do not fabricate `[embed]` paths, Canvas IDs or manifests; use
the descriptor returned by the actual native tool.

```json
{
  "title": "Team investment",
  "kind": "scenario-explorer",
  "widget_code": "{\"version\":1,\"language\":\"en\",\"summary\":\"Explore this delivery plan\",\"tasks\":[{\"label\":\"Implementation and testing\",\"hours\":448}],\"dailyRate\":700,\"budget\":80000,\"deadline\":21,\"people\":6,\"focus\":6}"
}
```

`widget_code` is a JSON **string**. Rejects unknown fields, non-integer inputs,
out-of-range numbers, excessive arrays and >32 KiB UTF-8 source. Summary and
labels are plain text. Computation and JS are fixed; no URLs, expressions or
arbitrary scripts are accepted. Native core owns wrapping, documents,
transcripts and capability admission. A fixed public JS resource is required by
the registered-kind contract; CSS stays inline to fit native widget CSP.

The illustrative formula is:

- Workload = sum of task hours.
- Daily capacity = people × focus hours × 0.82 × (1 − 0.025 × (people − 1)).
- Workdays = ceiling(workload / capacity).
- Cost = people × workdays × cost per person per workday.

This simple model is for demonstrating UI behavior, not estimating a real
project. It omits dependencies, holidays and workload parallelism constraints.

### General interactive answers

Use `kind: "interactive-answer"` with this document serialized into `widget_code`:

```json
{
  "version": 1,
  "language": "en",
  "summary": "Compare the supplied delivery options",
  "blocks": [
    {
      "type": "table",
      "id": "deliveries",
      "title": "Delivery times",
      "columns": [
        { "id": "option", "label": "Option", "type": "text" },
        { "id": "days", "label": "Days", "type": "number" }
      ],
      "rows": [
        ["Standard", 7],
        ["Express", 3]
      ]
    }
  ]
}
```

The shared contract is `ui/schema.ts`. Each block has `type`, unique `id`,
`title` and optional `note`; document `note` is also optional. IDs start with a
lowercase letter, followed by lowercase letters, digits or hyphens, at most 40
characters. Unknown fields are rejected with structural paths and fixed rules;
errors do not include source values. The source is at most 64 KiB UTF-8 and
contains 1–8 blocks. Ordinary text is limited to 400 UTF-16 code units; labels,
titles and units to 80. Numbers are finite, with absolute value at most 10^12.

| Block     | Source and local interaction                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `table`   | 1–8 typed `columns`, 1–100 matching `rows`; search, stable sort, five-row pages and one-row detail                  |
| `compare` | 1–8 ordered `metrics`, 2–6 `items` with matching `values`; choose an option without an inferred recommendation      |
| `chart`   | `line` or `bar`, 2–40 shared `labels`, 1–4 `series`; local series switches and a table using the same source values |
| `form`    | 1–12 text/number/select/checkbox `fields`; validate local inputs before creating a draft                            |
| `steps`   | 1–12 `{title,body}` items; expandable explanations                                                                  |

Form `value` is required. Text has optional `maxLength` (1–400, default 400).
Numbers allow `null` for an unfilled value, optional `min` and `max`, and cannot
coerce strings. Select options are 1–12 unique non-empty strings and `value`
must match one. Text, number and checkbox permit `required`, default false.
An initially empty required field is valid source but prevents continuation
until the user completes it. There are no expression, URL, HTML, RPC or script
fields; a form is not an arbitrary calculator or external submission endpoint.

The fixed UI resource has its own native public path,
`/__interactive_ui__/ui.js`; it does not share the scenario registration
path. The composer passes only validated data and translated labels to a fixed
renderer, and native core supplies the canonical wrapper and private bridge.
Missing or empty renderer responses display a translated fallback and raise a
fixed initialization error through the existing native error bridge, so the
host can offer reload or user-requested recreation without exposing resource
URLs or raw diagnostics.
Multiple blocks have separate panels that preserve values while switching.
State stays in iframe memory; reopening the document restores its defaults.
No product transcript cache, KV copy or persistent selection store is added.

Continuing analysis uses the existing review/add-to-draft/send flow. The draft
contains current interaction values, bounded to 3600 UTF-16 code units after
JSON escaping, with explicit omission counts. It does not include the entire
table. The iframe also exposes complete local interaction values for review
and copying. A new answer creates a new native document; neither streaming
components nor in-place historical updates are claimed.

Complete native payload examples and correction rules are in
`skills/interactive-answer/SKILL.md`. Plain text remains the default when it is
clearer; freeform interfaces may use the original native HTML kind.

The plugin ID is `interactive-ui`; its content kinds are `interactive-answer`
and `scenario-explorer`. Native storage identifies each by `pluginId:kind`,
while the tool selects the advertised content-kind ID. These names describe
the capability and contain no product branding. Existing immutable native
documents are not rewritten; generate a new widget after this naming change.

## Checks

```powershell
node node_modules/vitest/vitest.mjs run tests/scripts/interactive-ui
node scripts/test/interactive-ui/verify-runtime.mjs
```

The second command uses the locked runtime's actual content-kind registrar and
checks generated resource syntax. Full isolated native verification is:

```powershell
node scripts/test/interactive-ui/verify-gateway.mjs
```

It checks real plugin loading, originating capability filtering, the tool schema
and result, native manifest and wrapper, authenticated document view, the fixed
public renderer, history/restoration and explicit disable. Its provider is a
loopback fake model; it never reads transcript files or uses the app's active
config, state, credentials or Gateway.

Add `--ui` to exercise the `interactive-answer` kind with all five block types, the
separate public renderer, native authentication and history/restart. This
verifies the transport and plugin contract with synthetic data, not the
configured model's design or authoring quality.

Add `--tool-dispatch` to verify native Tool Search directory mode with the
scenario plugin disabled. The synthetic model calls `tool_call` using
`openclaw:core:show_widget` to produce ordinary native HTML. This separately
checks the core wrapper, outer call identity, authenticated view, native prompt
bridge and history/restart without repeating execution. This mode is independent
of the scenario-only `--retention` and `--extreme` variants.

Add `--retention` to create 33 real native widgets in a separate synthetic
session. Native core retains 32 documents per native session: the oldest becomes
unavailable, the remaining 32 still load, native history retains the descriptor,
and the original demo session stays unaffected. The script does not change the
native cap, write manifests or bypass tool permission/capability admission.

Add `--extreme` to exercise accepted maximum workload and cost inputs: 12 tasks
of 2000 hours, a 5000 CNY daily rate, 12 people and 2 focus hours. The fixed
formula yields 1683 workdays and 100,980,000 CNY. This variant checks narrow
metric layouts and dark native theme contrast using the same real tool flow;
it remains isolated synthetic data.

Verify the visible interaction through a normal application conversation using
the actual configured model. See the [current feature contract](../../docs/features/chat/interactive-answers.md)
for app viewer integration and admission gates, and the [pending acceptance checks](../../docs/plans/interactive-answers-acceptance.md)
for model quality, packaged applications and platform coverage.
