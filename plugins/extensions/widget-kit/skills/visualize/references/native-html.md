# Native HTML visualization and optional interaction

Use only the current turn's advertised `show_widget` HTML kind. Supply a short
`title` and the markup string in `widget_code`; let the host display the title.
Start with useful content, not another heading or card frame. Use `--font-body`,
`--text`, `--muted`, `--card`, `--border`, `--accent-fill` and `--accent-fg`.
Use HTML, SVG, canvas and local JavaScript as the task requires. No charting or
component library is preloaded. The advertised `html-page` kind also accepts
complete HTML and adapts HTTPS image loading; `widget_code` is raw markup.
Load needed libraries with scripts or ES modules under native CDN policy. Static presentations
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
For requested Internet images or data, the separate native network-download
path is described in [network downloads](pinned-network.md); its `pin` parameter
is consumed in the chat card, without requiring a dashboard or sidebar.

## Native inline resource policy

The following describes the current native sandbox, not additional permissions
granted by this skill. Inline and network-enabled chat widgets follow the same
native script/style/font resource policy. These resource loads use the browser
proxy and need no separate `capabilities.netOrigins` entry; that capability
controls fetch/XHR data access. Local drawing, embedded assets and system fonts
remain available when the network is unavailable.

| Resource or operation                                                      | Native inline policy                                                                                                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript and ES module imports                                           | Inline script and the CDN origins below; no arbitrary hosts or `eval`/`new Function`.                                                                                                               |
| CSS and fonts                                                              | Inline CSS; external stylesheets and fonts from the CDN origins below; fonts may also use `data:`.                                                                                                  |
| Images, CSS background images, video posters and image-backed GPU textures | `data:` only. Remote and `blob:` image URLs are blocked, including images from an allowed script CDN. Inline SVG and locally generated canvas/pixel textures do not need an external image request. |
| Audio/video element sources                                                | `data:`, `blob:` and direct HTTPS media. HTTP media is blocked. Remote playback depends on network availability and does not authorize script-driven fetching of media segments.                    |
| `fetch`, XMLHttpRequest, WebSocket and EventSource                         | No network/API connections in an inline document (`connect-src 'none'`), including requests to a CDN or an internal service.                                                                        |
| Nested external frames and parent application access                       | No external iframe embedding or direct parent/Gateway access. Use only the actual host's exposed bridge.                                                                                            |

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
`html-page` kind loads only its small installation-owned image adapter through
the native registered-resource interface. Libraries use author-supplied CDN URLs.
An allowed resource URL does not
establish network reachability or successful loading, and a script grant does
not change the image or connection policy. Local `file:` resource URLs are not
an alternative; put workspace file links in ordinary chat instead.

Native pinned documents have separate declared and granted network permissions.
This application's limited network viewer uses them for GET/HEAD resource reads;
the ordinary inline preview does not inherit them. Dashboard data/action tools
are not available here. Existing native documents keep their
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
Only the separately admitted network-download view may fetch a granted origin
and convert the image to a data URL, as documented in the network reference.

For existing pages or direct HTTPS image loaders, use Widget Kit's advertised
`html-page` kind with the original markup as its source.
Its image adapter runs before author code and converts HTTPS `image.src`,
`setAttribute('src', ...)` and static authored `<img src>` to fetched data URLs.
Three.js TextureLoader can keep its original URL and callbacks. This still needs
the network view's declared and granted origins; it does not change native CSP.
CSS backgrounds, posters, `srcset` and namespace attribute writes retain native
behavior. Complete HTML source is accepted by this plugin kind; ordinary native
`html` continues to use fragments.

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

Use a small, task-specific control when a follow-up is useful:

```html
<div id="discussion-example">
  <label>Value <input type="number" value="2" required /></label>
  <button type="button" disabled>Discuss this value</button>
  <p role="alert"></p>
</div>
<script>
  const root = document.getElementById('discussion-example');
  const input = root.querySelector('input');
  const button = root.querySelector('button');
  const error = root.querySelector('[role=alert]');
  let available = false;
  let pending = false;
  const update = () => {
    button.disabled = !available || pending;
  };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'openclaw:scenario-draft-policy') return;
    available =
      event.data.available === true && typeof window.openclaw?.prompt?.send === 'function';
    update();
  });
  button.addEventListener('click', async event => {
    if (!event.isTrusted || !available || pending || !input.reportValidity()) return;
    const value = input.valueAsNumber;
    if (!Number.isFinite(value)) return;
    pending = true;
    error.textContent = '';
    update();
    try {
      const prepared = await openclaw.prompt.send(`Explain this selected value: ${value}.`);
      if (prepared === false) error.textContent = 'Could not prepare the suggestion.';
    } catch {
      error.textContent = 'Could not prepare the suggestion.';
    } finally {
      pending = false;
      update();
    }
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
