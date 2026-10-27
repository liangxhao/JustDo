---
name: visualize
description: Display visual content in the current conversation through show_widget or embed UI. Use when asked to show a globe/3D scene, chart, diagram, simulation, interactive demo, HTML preview or existing webpage on screen, including content already produced with a design skill. Owns viewer selection and visible delivery; preserve explicit website/app implementation and file-only requests.
---

# Visualize

This skill handles where and how content appears in the conversation. Reuse
existing designs, source and data; create missing content as the task requires.
Complete the actual display: saving HTML or returning source alone does not
show it. Design skills may guide appearance without changing this delivery step.
Preserve explicit file-only and website/app implementation deliverables.

## Choose the delivery path

Choose by required behavior and currently offered capabilities. Networking or a
complete HTML document alone does not require an independent webpage.

| Required behavior | Delivery path |
| --- | --- |
| A concise explanation, ordinary table or supported Mermaid is enough | Use normal chat. |
| Draw a new globe/3D scene, diagram, simulation or calculator | Prefer `show_widget` with supplied data and local JavaScript. |
| Preview existing standalone HTML/SVG | Reuse the markup in `show_widget`; complete HTML can use advertised `html-page`. |
| A one-time lookup supplies the needed snapshot | Retrieve through authorized tools, then use a Widget; identify source and observation time. |
| An authored visual needs live anonymous HTTPS GET/HEAD images or data within Widget policy | Use `html` or `html-page` with native `pin`/`capabilities.netOrigins` admission; read [network downloads](references/pinned-network.md). |
| Show an existing URL, need ordinary webpage behavior beyond Widget policy, or explicitly embed a standalone hosted HTML page | Use embed UI when the independent viewer and target permit it; read [hosted HTML](references/hosted-html.md). |

## Deliver through show_widget

Discover the current `show_widget`, read its schema and call its exact tool ID.
Supply a short `title` and the actual source string in `widget_code`, not a file
path or Markdown fence. Use only advertised kinds and parameters:

- `html`: native HTML/SVG fragments with optional styles and scripts.
- `html-page`: fragments or complete HTML, with document-shell and HTTPS image
  adaptation. Preserve existing scripts/import maps; no JSON envelope is needed.
- `interactive-answer`: optional fixed components; read
  [fixed components](references/fixed-components.md) only when they fit.

The host displays the result inline. Expanding it or moving it to the sidebar
uses host controls; keep the existing document rather than delivering a duplicate.
No visualization libraries are preloaded. For dependencies, container sizing and the
human-confirmed composer draft bridge, read [native HTML](references/native-html.md).
For webpage links or a search box, use real links as shown there; Widget navigation
does not support `window.open()` or external form submission.
For external images/data, also read [network downloads](references/pinned-network.md).
Use configured services and task-appropriate resources; retain user/organization
constraints and do not introduce public fallbacks for internal services.

## Deliver through embed UI

For an existing HTTP(S) URL, emit a quoted shortcode in normal assistant text,
outside code fences/backticks:
`[embed url="https://target.example/page" title="Page" height="640" /]`.
No tool call is needed. The host checks the external-URL setting and target;
if blocked, provide a normal link and explain the actual limit.

For a new standalone page, read [hosted HTML](references/hosted-html.md), write
the actual files under the current Gateway profile's `canvas/documents`, then
emit `[embed ref="REAL_STAGED_ID" title="Report" height="480" /]`.
Hosted refs need no external-URL switch. Neither path needs `show_widget` or a
Widget manifest. See [worked examples](references/delivery-examples.md) when
needed. External URLs share the default built-in browser's site login/storage;
hosted refs remain isolated. Neither exposes a Widget draft bridge.
The resulting webpage card also supports the host's expansion and sidebar controls.

If `show_widget` is missing, an independently offered hosted viewer can deliver
an authored visual. Pending/rejected grants or blocked Widget resources are not
reasons to switch viewers or strip restrictions. If a path is unavailable, state
the concrete limit and provide a real link/file alternative. Do not change the
external-URL setting without authorization or copy a blocked site into a hosted
ref to evade it.

## Verify and deliver

Read the Widget result and check the requested interaction in the actual viewer
when accessible. A requested draggable/rotatable model needs working interaction,
not a static illustration. Otherwise distinguish source checks from visual verification;
file creation or an initialized iframe alone proves no loading success. Correct
source errors before retrying; never replay uncertain execution or fabricate
Widget IDs, hosted references or persistence APIs. After success, add only a
useful conclusion or material verification limit.
