---
name: visualize
description: Show visual content in the conversation, including interactive 3D globes, simulations, HTML pages, charts and existing websites. Complete visible delivery of content produced by design skills; preserve explicit file-only and app-development requests.
---

# Visualize

Reuse existing designs, source and data. An on-screen request needs a working
viewer; saving HTML or returning code alone does not complete it. Design skills
guide appearance while this skill chooses delivery.

## Choose the viewer

| Content | Delivery |
| --- | --- |
| Existing HTTP(S) website | Embed its URL. |
| Authored complete HTML, interactive 3D globe/scene, game, simulation or page with external resources | Default to a hosted page and embed its ref. |
| Compact self-contained charts, diagrams and calculators; cards needing the conversation draft bridge | Use `show_widget`. |
| Text, an ordinary table or supported Mermaid already explains it | Use normal chat. |

Choose the path before authoring. Keep complete pages and their normal resource
loading in the webpage viewer; do not add Widget pinning or network capabilities
to make a page fit the Widget sandbox.

## Embed a webpage

For an existing URL, emit this syntax in normal assistant text, outside code
fences/backticks:
`[embed url="https://target.example/page" title="Page" height="640" /]`.
No tool call is needed. External URLs require the Browser setting “Allow external
webpages in messages”; if blocked, provide a normal link and explain the limit.

For an authored page, read [hosted HTML](references/hosted-html.md), write the
files under the verified current Gateway profile's `canvas/documents`, then emit
`[embed ref="REAL_STAGED_ID" title="Interactive page" height="640" /]`.
Read [delivery examples](references/delivery-examples.md) for a complete page,
relative assets, staging and a small Widget. Hosted refs need no external-URL
switch. A local path, `file://` URL or guessed ref is not a published page.

Both webpage paths follow the Browser proxy setting and support expansion and
sidebar presentation. External URLs share the default sidebar browser's site
login/storage; hosted refs are isolated. Webpages have no Widget draft bridge.

## Show a compact Widget

Discover the real `show_widget` and use its current schema. Pass a short `title`
and the HTML/SVG fragment string as `widget_code`, with `kind: "html"`.
Use supplied data, inline assets and local JavaScript. For native resource limits,
links or the optional human-confirmed draft bridge, read
[native HTML](references/native-html.md).

When its fixed table/chart/form components fit and the kind is advertised, use
`interactive-answer`; read [fixed components](references/fixed-components.md).
No visualization library is preloaded. Keep explicit file/app deliverables and
user-selected presentation paths intact.

## Verify delivery

Check loading and requested interactions in the actual viewer when accessible.
A rotatable globe needs working rotation, not a static illustration. Distinguish
source checks from visual verification when the viewer is unavailable. Correct
source errors before retrying; do not replay an uncertain tool call or fabricate
hosted references. If a path is unavailable, explain the concrete limit and
provide a real link/file. Do not change settings or rewrite a denied saved Widget
into a webpage to bypass its decision.
