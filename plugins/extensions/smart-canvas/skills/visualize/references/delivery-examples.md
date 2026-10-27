# Delivery examples: Widget and embed UI

Choose the required experience first. These are examples of real tool arguments
and assistant-message syntax, not calls that have already happened. Read the
current tool schema; use only its advertised kinds. In actual delivery, call
the tool or emit the shortcode outside code fences instead of returning the
example as source code. Example document IDs must be replaced with fresh IDs
for files actually staged in the current profile's hosting root.

## 1. Draw a globe here → show_widget

Request: “在界面上画一个地球，不要只给我代码。”

This is an authored visual, so prefer `show_widget`. Discover its actual tool
ID and pass source in `widget_code`. No local HTML file or embed reference is
needed. This small static illustration works without textures, a library or
network access:

```json
{
  "title": "地球示意图",
  "kind": "html",
  "widget_code": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 280' role='img' aria-label='地球示意图，展示海洋、简化陆地与经纬线' style='display:block;width:100%;max-width:420px;margin:auto'><defs><clipPath id='earth-demo-clip'><circle cx='160' cy='140' r='104'/></clipPath></defs><circle cx='160' cy='140' r='104' fill='#1974b9'/><g clip-path='url(#earth-demo-clip)'><path d='M70 80L108 51L142 68L131 107L103 124L84 105Z M106 139L141 150L158 181L132 226L115 188Z M177 68L221 59L258 97L224 121L201 109L193 144L169 127Z M181 143L211 152L221 188L197 210L176 174Z' fill='#6eba80'/><g fill='none' stroke='#ffffff' stroke-opacity='.45'><ellipse cx='160' cy='140' rx='52' ry='104'/><ellipse cx='160' cy='140' rx='104' ry='48'/><path d='M56 140H264M160 36V244'/></g></g></svg>"
}
```

If the user asks to rotate or drag the globe, implement that behavior in
Canvas/WebGL/local JavaScript and submit the working source through the same
tool. A static SVG is not a rotatable 3D model. If a real texture is needed,
read [network downloads](pinned-network.md): choose advertised `html-page`,
declare exact origins with native `pin`/`capabilities.netOrigins`, preserve
loader callbacks and show actual failures. Do not assume Three.js is preloaded
or switch to embed just because the visual uses a library or live data.

If source was already produced with a design skill or earlier in the task,
reuse it and perform the viewer handoff; do not stop at the saved file.

## 2. Display complete authored HTML → show_widget html-page

Request: “把这段完整 HTML 作为可操作的卡片展示在对话里。”

Complete HTML can still use a Widget. When `html-page` is advertised, pass the
actual markup string, not the filename, `file://` URL or a JSON wrapper inside
`widget_code`. This example has real local interaction and no network requests:

```json
{
  "title": "本地计数器",
  "kind": "html-page",
  "widget_code": "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'></head><body><main id='counter-demo'><button type='button'>增加一次</button><output aria-live='polite'>0</output></main><script>{const root=document.getElementById('counter-demo');let count=0;root.querySelector('button').addEventListener('click',()=>{root.querySelector('output').textContent=String(++count);});}</script></body></html>"
}
```

For networked HTML, use the separate
[complete network-call example](pinned-network.md#tool-arguments). Source format
alone does not choose the display path. Keep an explicit file-only deliverable
as a file; do not convert it into a Widget without regard to that request.

## 3. Show an existing website → external URL embed UI

Request: “在这条消息里打开 https://www.hao123.com/ 给我看。”

Output this shortcode as normal assistant text; no tool call is needed:

```text
[embed url="https://www.hao123.com/" title="hao123" height="640" /]
```

The result is a webpage card with a title bar and the site's own page content;
it is not a Widget document. Do not download/rewrite the site or call
`show_widget` for this path. It loads as a top-level page and shares the default
built-in browser's site login/storage; other profiles and Chrome remain separate.

If the host reports external webpages are disabled, provide the normal site
link and explain the Browser setting “Allow external webpages in messages”.
Do not silently enable it, clone the site into a hosted ref or claim the link
is an embedded result.

## 4. Explicitly host a standalone HTML page → hosted ref embed UI

Request: “请用独立网页方式展示这份报告，直接嵌在对话里。”

Use an existing authorized host-exec tool to read the current Gateway host's
nonempty `OPENCLAW_STATE_DIR`. Set `documentsRoot` to that directory's
`canvas/documents`, as described in [hosted HTML](hosted-html.md); do not guess
a profile directory. Through authorized file tools, create a fresh document
directory. The following ID is illustrative:

```text
<documentsRoot>/report-demo-7b9e/index.html
<documentsRoot>/report-demo-7b9e/styles.css
```

`index.html` contains a normal, self-contained page with a relative static asset:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="./styles.css">
  <title>报告详情</title>
</head>
<body>
  <main>
    <p>本页演示独立 HTML 的静态资源和本地交互。</p>
    <button id="report-details-toggle" type="button" aria-expanded="false" aria-controls="report-details">展开详情</button>
    <p id="report-details" hidden>这是已经写入页面的报告详情。</p>
  </main>
  <script>
    const button = document.getElementById('report-details-toggle');
    const details = document.getElementById('report-details');
    button.addEventListener('click', () => {
      details.hidden = !details.hidden;
      button.setAttribute('aria-expanded', String(!details.hidden));
      button.textContent = details.hidden ? '展开详情' : '收起详情';
    });
  </script>
</body>
</html>
```

`styles.css`:

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 20px; }
main { max-width: 64rem; margin: auto; }
button { padding: 8px 12px; font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid #4f78e6; outline-offset: 3px; }
```

After both files actually exist, emit the real ID outside code fences:

```text
[embed ref="report-demo-7b9e" title="独立报告" height="480" /]
```

The equivalent hosted URL form is:

```text
[embed url="/__openclaw__/canvas/documents/report-demo-7b9e/index.html" title="独立报告" height="480" /]
```

Use one form, not both for the same page. Hosted refs do not require
the external-URL setting. Do not stage a Widget manifest, invoke `show_widget`
or emit a guessed ID before writing the files. This static document directory
does not provide a backend, arbitrary files or business POST/API routes.

The resulting card displays the hosted page and its local button. Verify both
loading and interaction if observable. A successful file write does not prove
that the native Canvas service or viewer loaded it.

## Failures and explicit output choices

| Situation | Appropriate completion |
| --- | --- |
| The user asks for a downloadable `globe.html` only | Deliver the real file; do not force a card. |
| The user asks to implement a globe component in an existing app | Modify and verify that app; an inline sketch is not the implementation. |
| The Widget tool is not offered, but an independent hosted viewer is available and fits the requested visual | Stage the real new page and emit its ref as in example 4. Do not equate a missing tool with a rejected grant. |
| No suitable actual viewer is offered | State the missing capability and provide a useful authorized artifact/link, clearly identified as the alternative. |
| Native Widget network permission is pending or rejected | Follow the native decision; do not reroute to embed to bypass it. |
| A target site needs popup POST, a real opener window or downloads | Report the limit and provide a normal browser link; ordinary new-window HTTP(S) GET links already open in the sidebar. |

Both paths can use browser proxy settings while keeping Widget grants, storage
and bridges separate. Independent embedding grants no parent application
access or automatic model follow-up. Its sandbox allows scripts, same-origin
page behavior and forms. External pages' normal new-window links open in the
sidebar; a real popup window, popup POST, app/system permissions and downloads
are unavailable. Follow the [hosted-page contract](hosted-html.md) for remaining limits.
