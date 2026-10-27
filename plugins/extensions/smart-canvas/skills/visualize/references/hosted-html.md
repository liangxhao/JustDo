# Hosted HTML

Use this path for authored complete pages, 3D scenes, games, simulations and
resource-dependent visuals. Existing website URLs can be embedded directly.

## Stage an authored page

Through an existing authorized host-exec tool, read the nonempty
`OPENCLAW_STATE_DIR` from the current Gateway host's environment and verify that
it is an existing absolute directory. The documents root is
`<OPENCLAW_STATE_DIR>/canvas/documents`. If execution is on another or sandboxed
host, or that environment value is unavailable, do not guess a profile path;
explain the limitation and provide the actual file or another supported viewer.

Create a fresh ASCII document ID, then write
`<documentsRoot>/<documentId>/index.html` and its document-relative assets.
Use ordinary HTML and its existing scripts, styles and loaders. No Widget
manifest, image conversion, pinning or network grant is needed. Use available
or configured assets; do not assume a library is preloaded or introduce public
CDN/service fallbacks for internal or offline content.

After the files exist, emit the actual ID as normal assistant text:
`[embed ref="REAL_STAGED_ID" title="Interactive page" height="640" /]`.
See [delivery examples](delivery-examples.md) for executable staging and a page
with a relative stylesheet. A workspace file, local server or `file://` URL is
not a hosted document. Relative URLs serve only the document's static assets;
business APIs need their own reachable URL, authorization and CORS.

## Viewer behavior

Both hosted refs and external URLs follow Settings / Browser / Browser proxy,
defaulting to the system proxy, and support the card's expand/sidebar controls.
Hosted refs use an isolated temporary session and shell/iframe. External URLs
load as top-level pages and share the default sidebar browser's Cookies,
same-origin localStorage/IndexedDB and site workers; sessionStorage and page
memory remain per page. Other profiles and Chrome are separate.

Scripts and forms are available within normal page security rules. CORS, CSP,
mixed content and Cookie/SameSite rules still apply; hosted iframes also obey
frame-ancestors/X-Frame-Options. External HTTP(S) GET links requesting a new
window open in the current conversation's sidebar. Hosted popups, popup POST
flows and features requiring a real opener are unsupported. Downloads, system
permissions and application/Widget bridges are unavailable.

External URLs require the external-webpage setting; hosted refs do not. Respect
blocked targets and settings rather than cloning a site into a hosted ref.
Referencing an existing `show_widget` document by URL retains its native CSP;
do not strip that policy or rewrite denied saved documents to bypass it.
