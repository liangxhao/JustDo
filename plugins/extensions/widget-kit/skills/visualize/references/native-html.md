# Native HTML visualization and optional interaction

Use only the current turn's advertised `show_widget` HTML kind. Supply a short
`title` and the markup string in `widget_code`; the host supplies the card frame
and title. Available theme variables are `--font-body`,
`--text`, `--muted`, `--card`, `--border`, `--accent-fill` and `--accent-fg`.
Use HTML, SVG, canvas and local JavaScript as the task requires. No charting or
component library is preloaded. The advertised `html-page` kind also accepts
complete HTML and adapts HTTPS image loading; `widget_code` is raw markup.
Load needed libraries with scripts or ES modules under native CDN policy. Static presentations
need no controls or scripts.
When controls help, keep them responsive, label inputs, and make local computations
deterministic.
If adding a conversation follow-up action,
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

## Web links and search

Real HTTP(S) `<a href>` activations open the current conversation's sidebar
browser. For a search box, update the search link's `href` as the user types;
let the user click it or focus the link and press Enter. `window.open()` and
external form navigation are blocked. A scripted `.click()` is not a real user
activation; do not use it to implement Enter in the input.

Example for a user-requested Baidu search; use the requested service's endpoint
and query parameter for other destinations:

```html
<div id="search-demo">
  <label for="search-demo-query">搜索关键词</label>
  <input id="search-demo-query" type="search" value="你好" />
  <a id="search-demo-link" target="_blank" rel="noopener noreferrer">搜索</a>
</div>
<script>
{
  const root = document.getElementById('search-demo');
  const input = root.querySelector('input');
  const link = root.querySelector('a');
  const update = () => {
    const query = input.value.trim();
    if (!query) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      return;
    }
    const url = new URL('https://www.baidu.com/s');
    url.searchParams.set('wd', query);
    link.href = url.href;
    link.removeAttribute('aria-disabled');
  };
  input.addEventListener('input', update);
  update();
}
</script>
```

Use the normal `html` kind; opening a link does not require Widget network grants.
Correct the source and generate a new Widget when an existing card uses the
wrong navigation method; saved cards do not inherit skill changes.

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

For existing complete HTML source or direct HTTPS image loaders, use Widget Kit's advertised
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

## Fit the host surface

The host supplies the card frame and title. Keep content readable at the actual
inline and enlarged sizes, with working controls and visible keyboard focus.
Preserve existing design choices while adapting container sizing and host theme
variables. Check loading and interaction in the intended Widget viewer; a
successful tool result alone does not prove that every script or asset loaded.

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
