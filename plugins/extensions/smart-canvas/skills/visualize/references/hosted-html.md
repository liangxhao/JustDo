# Hosted HTML delivery

Use the delivery paths in [Visualize](../SKILL.md).
Read [delivery examples](delivery-examples.md) for concrete calls and a complete
HTML/relative-CSS example.

## Hosting and URL access

For a new page, read the nonempty `OPENCLAW_STATE_DIR` from the current Gateway
host's environment through an existing authorized host-exec tool. The hosting
root (`documentsRoot`) is `<OPENCLAW_STATE_DIR>/canvas/documents`. If that value
is unavailable or execution is on a different/sandboxed host, do not guess a
profile path; use another supported delivery path or provide the actual file.
Stage a normal HTML document under a fresh ASCII ID as
`<documentsRoot>/<documentId>/index.html`, with document-relative static assets.
The authenticated static service serves
these files; a workspace file, guessed ID, local port or `file://` path is not
a published document. No Widget manifest, image adapter or application bridge
is added to hosted HTML.

Document-relative URLs serve static assets, not business APIs or arbitrary
filesystem paths. External APIs need their own reachable URL, CORS and
authorization. A missing file/service produces an unavailable card.

An existing HTTP(S) URL needs only the message shortcode. The host enforces
Settings / Browser / “Allow external webpages in messages”; when disabled,
provide a normal link and identify the setting if relevant. Do not copy the
site into a hosted ref to evade the switch.

## Page behavior and isolation

External URLs load as top-level pages without preload, sharing the default
built-in browser's cookies, same-origin localStorage/IndexedDB and site workers.
Other profiles, Chrome, per-page sessionStorage and page memory remain separate.
Hosted refs retain their own temporary session and shell/iframe, without that
shared login. Both permit scripts and forms. External pages' HTTP(S) GET links
that request a new window open in the current conversation's sidebar browser;
the original page stays loaded. Hosted pages, popup POST submissions and flows
requiring a real opener/popup remain unsupported. Neither path offers downloads,
app/system permissions or parent application access. A login requiring those
features may need the normal browser. CSP, CORS and Cookie/SameSite rules remain
in force. X-Frame-Options/frame-ancestors constrain iframe embedding, including
hosted refs; they do not reject an external URL's top-level page load.

Ordinary page behavior is available only where the host and service permit it.
Do not embed credentials in source/URLs or copy application, Gateway or Widget
bridges into the page. Independent pages have no Widget composer draft bridge,
and neither borrows Widget grants, tickets or cookies.

A `show_widget` document keeps its native CSP even when referenced by URL. Do
not strip it or rewrite a denied Widget into a less restricted viewer to bypass
its grant/resource decision. Choose the delivery path from the required behavior
before authoring, following the selection table in the skill.

## Browser proxy

The viewer follows Settings / Browser / Browser proxy (`browserProxy`), defaulting
to the system proxy like the sidebar browser. Keep networking in the host; do
not add proxy clients, credentials, direct/public fallback routes or change
settings to make a page load without authorization. Proxy settings do not remove
the target's security or login restrictions. The Widget download viewer retains
its separate, stricter anonymous GET/HEAD contract.
