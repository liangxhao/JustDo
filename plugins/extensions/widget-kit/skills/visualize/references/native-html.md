# Native HTML visualization and optional interaction

Use only the current turn's advertised `show_widget` HTML kind. Supply a short
`title` and the markup string in `widget_code`; let the host display the title.
Start with useful content, not another heading or card frame. Use `--font-body`,
`--text`, `--muted`, `--card`, `--border`, `--accent-fill` and `--accent-fg`.
Use HTML, SVG, canvas and local JavaScript as the task requires. No charting or
component library is preloaded in ordinary `html`. For the advertised
`offline-html` kind, read [offline libraries](offline-libraries.md) to select
bundled Three.js, ECharts, KaTeX, Mermaid, D3 or Matter.js. Static presentations
need no controls or scripts.
When controls help, keep them responsive, label inputs, and make local computations
deterministic.
Give the content consistent padding and use the available width; do not leave a
narrow form against the card edge. If adding a conversation follow-up action,
prefer a `type="button"` click handler, validate inputs synchronously, and await
the bridge result.
Use system fonts and inline assets so the result works without public network
access. Gather data through authorized agent tools before rendering; an inline
widget has no dashboard data/action grants or credentials.

## Native inline resource policy

The following describes the current native sandbox, not additional permissions
granted by this skill. This project's offline deployment is stricter: author
self-contained content with inline assets, local drawing and system fonts even
where the native policy permits a public resource.

| Resource or operation | Native inline policy |
| --- | --- |
| JavaScript and ES module imports | Inline script and the CDN origins below; no arbitrary hosts or `eval`/`new Function`. |
| CSS and fonts | Inline CSS; external stylesheets and fonts from the CDN origins below; fonts may also use `data:`. |
| Images, CSS background images, video posters and image-backed GPU textures | `data:` only. Remote and `blob:` image URLs are blocked, including images from an allowed script CDN. Inline SVG and locally generated canvas/pixel textures do not need an external image request. |
| Audio/video element sources | `data:`, `blob:` and direct HTTPS media. HTTP media is blocked. Remote playback depends on network availability and does not authorize script-driven fetching of media segments. |
| `fetch`, XMLHttpRequest, WebSocket and EventSource | No network/API connections in an inline document (`connect-src 'none'`), including requests to a CDN or an internal service. |
| Nested external frames and parent application access | No external iframe embedding or direct parent/Gateway access. Use only the actual host's exposed bridge. |

The native script/style/font allowlist is:

- `https://cdnjs.cloudflare.com`
- `https://cdn.jsdelivr.net`
- `https://esm.sh`
- `https://unpkg.com`
- `https://fonts.googleapis.com`
- `https://fonts.gstatic.com`
- `https://fonts.bunny.net`

Imports, stylesheet dependencies, font files and redirects must also stay within
the allowed origins. Ordinary `html` has no preloaded library. The separate
`offline-html` kind loads only its declared, installation-owned scripts through
the native registered-resource interface. An allowed resource URL does not
establish network reachability or successful loading, and a script grant does
not change the image or connection policy. Local `file:` resource URLs are not
an alternative; put workspace file links in ordinary chat instead.

Pinned dashboards have separate declared and granted data/action permissions.
An inline preview does not inherit them. Existing native documents keep their
saved policy; changing a source file or this skill does not repair an old card.
Generate a new document through the real tool after correcting the source.

## Local interaction

Keep filtering, calculation, selection and simulation in the document. Initialize
both the controls and the result from the same model. Validate finite numeric
values and required fields; represent empty results and invalid inputs clearly.
Insert external labels and user text with `textContent`, not executable markup.
Avoid `eval` and generated script strings. Encode embedded JSON safely, including
any `<` characters that could terminate a script element.

Use a root ID unique to this document and scope selectors and styles to it.
Resize canvas backing stores with the container and pixel ratio; use an SVG
`viewBox` with readable labels. Stop animations or expensive simulations when
hidden, keep requested animations active even when system reduced motion is
enabled, and redraw theme-dependent graphics when the host
theme changes. Do not invent an SDK for local calculations or save document
state in browser storage.

## Images and GPU textures

The native inline document allows images only as `data:` URLs. A library being
allowed by `script-src` does not authorize that library's image requests: this
also applies to image-backed WebGL textures, including Three.js `TextureLoader`.
Do not load texture images, posters or CSS background images from a CDN, even
when its JavaScript modules are allowed. Embed required images as data URLs, or
create textures locally with canvas or typed pixel data. Inline `fetch` is also
blocked, so fetching an image in the widget and converting it is not a workaround.

Track actual asset completion and errors with the loader's documented callbacks
or promises. Keep a readable fallback or explicit failure state when a texture
cannot load; do not present a black or incomplete model as a successful render.
A timer may report slow loading, but must not pretend loading succeeded. Verify
the asset-dependent result in the intended widget surface when accessible;
success in an ordinary browser page does not establish sandbox compatibility.

## Visual foundations, not a business template

Choose content and layout from the user's task; the example below is not a
preferred use case. Reuse these foundations for calculators, diagrams, planners,
custom controls or other layouts without forcing them into a fixed component.

- Inherit the host font, colors and color scheme. Use a transparent page and one
  content surface; the chat already supplies a frame and title. Avoid nested
  cards around every field, large hero headings and decorative gradients.
- Use border-box sizing, a 4/8px spacing rhythm, 16–24px outer padding, 12–16px
  control gaps, and a clear 14–16px body hierarchy. Controls inherit the font.
  Give inputs visible labels, a comfortable height and visible keyboard focus.
- Use the available width. A deliberately narrow reading column is centered;
  grids use minmax(0, 1fr), children use min-width: 0, and long text wraps.
  Collapse columns on small screens; avoid fixed page widths or heights.
  Wide tables may scroll inside a named region, never widen the whole page.
- Start with the useful content. Add actions when the task needs them;
  local calculation and selection update immediately. Do not add submit, review,
  reset, export or copy actions without a task-specific reason. No sending
  tutorial, success toast or "widget ready" footer.
- Keep units beside values. Put secondary assumptions in a details disclosure.
  Show errors only after a relevant failed operation, next to the affected
  control, with a brief correction or retry. Preserve entered values; never
  expose raw stack traces or show model execution success on bridge delivery.

Before the tool call, review the actual markup and handlers: fit at roughly
320px and 800px content widths, readable light/dark colors, no duplicate title,
no unsupported action claims, valid inputs, and a real handler for each action.
This is an authoring checklist, not text to display to the user. After a successful
call, let the card be the answer; do not append a walkthrough or repeat its data.

## Optional conversation follow-up

Most widgets need no model follow-up. When it is useful, a real user-clicked
control may call `openclaw.prompt.send(text)` to prepare a suggestion containing
the selected values and a clear requested action. This application then offers
"加入草稿" / "Add to draft"; the user still sends through normal chat.

Keep text nonempty, within 4,000 UTF-16 code units, and free of leading slash or
execution prefixes. The canonical bridge checks real activation, visibility,
focus and the current session. Capture and validate values synchronously before
calling it; do not defer the call through timers or earlier asynchronous work.
Feature detection alone does not establish current draft availability: listen
for the parent's `openclaw:scenario-draft-policy` message as below. This existing
transport name applies to native HTML too; it does not select a business template.

This example combines an immediate local calculation with an optional discussion
button. Adapt or omit either interaction according to the task:

```html
<style>
  #value-explorer, #value-explorer * { box-sizing: border-box; }
  #value-explorer { color: var(--text); background: transparent;
    font-family: var(--font-body, system-ui, sans-serif); font-size: 14px; line-height: 1.5; }
  #value-explorer { padding: clamp(16px, 3vw, 24px); min-width: 0; overflow-wrap: anywhere; }
  #value-explorer label { display: grid; min-width: 0; gap: 8px; }
  #value-explorer :is(input, button) { font: inherit; }
  #value-explorer input {
    width: 100%; min-width: 0; min-height: 40px; padding: 10px; color: inherit;
    background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  #value-explorer .actions { display: flex; justify-content: flex-end; margin-top: 20px; }
  #value-explorer button { min-height: 40px; max-width: 100%; padding: 9px 16px; border: 0; border-radius: 8px;
    background: var(--accent-fill); color: var(--accent-fg); cursor: pointer; white-space: normal; }
  #value-explorer :is(input, button):focus-visible { outline: 2px solid var(--accent-fill); outline-offset: 3px; }
  #value-explorer button:disabled { opacity: .45; cursor: default; }
  #value-explorer .error { color: var(--danger, var(--text)); font-size: 13px; margin: 12px 0 0; }
</style>
<main id="value-explorer">
  <label>Input value<input type="number" min="-1000000" max="1000000" step="any" required value="2"></label>
  <p>Squared value: <output aria-live="polite">4</output></p>
  <p class="error" role="alert" hidden></p>
  <div class="actions"><button type="button" disabled>Discuss this value</button></div>
</main>
<script>
  const root = document.getElementById('value-explorer');
  const input = root.querySelector('input');
  const output = root.querySelector('output');
  const button = root.querySelector('button');
  const error = root.querySelector('.error');
  let available = false;
  let pending = false;
  const showError = text => { error.textContent = text; error.hidden = !text; };
  const update = () => { button.disabled = !available || pending; };
  input.addEventListener('input', () => {
    output.value = input.validity.valid && Number.isFinite(input.valueAsNumber)
      ? String(input.valueAsNumber ** 2) : '—';
  });
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'openclaw:scenario-draft-policy') return;
    available = event.data.available === true && typeof window.openclaw?.prompt?.send === 'function';
    update();
  });
  button.addEventListener('click', async event => {
    if (!event.isTrusted || !available || pending) return;
    if (!input.reportValidity()) return;
    const value = input.valueAsNumber;
    // Capture and validate synchronously, while the native activation is current.
    pending = true;
    showError('');
    update();
    try {
      const prepared = await openclaw.prompt.send(
        `Explain the relationship in this example using my selected value ${value} and its square ${value ** 2}.`
      );
      if (prepared === false) showError('Could not prepare the suggestion. Try again.');
    } catch {
      showError('Could not prepare the suggestion. Try again.');
    } finally { pending = false; update(); }
  });
</script>
```

The policy message controls availability only; it grants no execution authority.
The canonical bridge checks actual activation and the host checks the current
session. Its `true` result means local bridge delivery, not model acceptance,
saving, or task completion. The host reviews the suggestion before appending to
the composer; the user still sends. Never call it on load, on a timer, or for
each keystroke. Use the user's language, including errors and units.

After the user sends, use their confirmed values as the next widget's initial
values. Call the real tool again for a new document; never invent an update API.
