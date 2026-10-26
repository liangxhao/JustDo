# Internet resources in chat widgets

Use this reference when a visualization needs Internet images or data while it
runs. Discover the real `show_widget` schema first. Native `pin: true` documents
remain in the chat; the user needs no dashboard or internal asset server. Existing
session policy may grant, request confirmation or reject. Declaring an origin does
not itself grant access, and the model must not add its own approval dialog.

## Tool arguments

Prefer `html-page` for complete HTML or automatic HTTPS image loading. Its source
is the raw markup string, with no JSON envelope or library list. For example:

```json
{
  "title": "Image explorer",
  "name": "image-explorer",
  "kind": "html-page",
  "pin": true,
  "capabilities": { "netOrigins": ["https://assets.example.com"] },
  "widget_code": "<img src=\"https://assets.example.com/image.png\" alt=\"Selected image\">"
}
```

The example origin is a placeholder. Use user-supplied URLs or verify actual
sources with authorized search/browser tools. Declare needed exact HTTPS origins,
including nondefault ports; native declarations accept no credentials, wildcard,
path, query or fragment. A browser navigation succeeding does not establish CORS
fetch access from an opaque widget.

For `html-page`, the plugin fills omitted `pin` and `netOrigins` from explicit
HTTPS URLs in the source. Existing declarations and `pin: false` are preserved;
dynamic host expressions need explicit origins. This requests native permission,
without rewriting the source or granting access itself.

Keep existing Three.js imports, TextureLoader URLs and load/error callbacks.
`html-page` automatically converts HTTPS image `src`, `setAttribute('src', ...)`
and authored static `<img src>` to fetch → FileReader → data URL. CSS backgrounds,
posters, `srcset`, namespace attribute writes and Blob image URLs retain native
behavior. Ordinary `html` has no adapter and needs explicit data URLs for images.

Scripts, ES modules, stylesheets and fonts use the native CDN policy in
[native HTML](native-html.md), including transitive imports and redirects. They
need no extra `netOrigins`; fetch/XHR uses separately declared and granted origins.
No libraries are preloaded or installed on first use.

## Network and state behavior

- Requests use the browser system proxy. Proxy and source failures are visible;
  do not substitute Node fetch or another service.
- The viewer supports anonymous GET/HEAD without a request body, source cookies
  or Authorization. Uploads, network forms and WebSocket are unavailable. URL and
  query information reaches the source; never put sensitive context in URLs.
- The source must allow CORS and present a valid HTTPS certificate. Fetch with
  `credentials: 'omit'`; native redirects stay within the granted connection
  policy. The image adapter adds no domain, size or timeout policy.
- Native `img-src data:` remains in effect; the adapter converts images rather
  than changing CSP. Unsupported loaders and decoders must be supplied explicitly
  under native resource rules. No texture catalog is bundled or discovered.
- Track real completion and failure, preserve a useful fallback and dispose
  textures/renderers on exit. Internet assets are not saved for offline use.

Use distinct names for separate views. Updating the same name replaces saved
source, not a running page's local state. New live results may load after native
permission; history requires explicitly loading the current saved version. Never
replay an uncertain tool call or treat a historical name as an immutable source ID.

The viewer exposes no Dashboard state/data/action/cron tools or automatic agent
messages. Optional conversation follow-up uses the existing human-confirmed draft
flow in [native HTML](native-html.md). Session, permission, connection or lease
changes can stop a view; restart requires explicit reload.
