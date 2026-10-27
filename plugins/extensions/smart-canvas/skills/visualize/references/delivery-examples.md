# Delivery examples

These examples show source and delivery syntax. Actual delivery requires writing
the files or calling the current tool, then displaying the result.

## Authored interactive page → hosted ref

Requests such as “生成一个可旋转的 3D 地球，直接在对话里展示” default to this
path. Build the requested page and its interactions, stage its files, then emit
its real ref. Reuse source already created by a design skill. A static picture
does not satisfy a requested interactive 3D model.

The small page below demonstrates the file and interaction contract without an
external library. Save it as `index.html` alongside `styles.css` in the current
authorized working directory before staging.

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="./styles.css">
  <title>交互参数</title>
</head>
<body>
  <main>
    <label>速度 <input id="speed" type="range" min="1" max="10" value="2"></label>
    <output id="value" for="speed">2</output>
    <button id="details-toggle" type="button" aria-expanded="false" aria-controls="details">查看说明</button>
    <p id="details" hidden>拖动滑块可以调整速度。</p>
  </main>
  <script>
    const speed = document.getElementById('speed');
    speed.addEventListener('input', () => {
      document.getElementById('value').textContent = speed.value;
    });
    const button = document.getElementById('details-toggle');
    const details = document.getElementById('details');
    button.addEventListener('click', () => {
      details.hidden = !details.hidden;
      button.setAttribute('aria-expanded', String(!details.hidden));
    });
  </script>
</body>
</html>
```

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 20px; }
main { display: grid; gap: 16px; max-width: 40rem; margin: auto; }
button { padding: 8px 12px; font: inherit; }
button:focus-visible { outline: 2px solid #4f78e6; outline-offset: 3px; }
```

Through the existing authorized exec tool on the Gateway host, run the following
JavaScript with its available Node interpreter. First verify that the tool runs
on that host. It reads the real environment, creates a fresh document directory,
copies the two authored files and prints the actual shortcode; no Gateway or
server is started. Copy any additional page assets into the same document tree.

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!stateDir?.trim() || !path.isAbsolute(stateDir) || !fs.statSync(stateDir).isDirectory()) {
  throw new Error('Current Gateway state directory unavailable');
}
const documentsRoot = path.join(fs.realpathSync(stateDir), 'canvas', 'documents');
const documentId = `page-${randomUUID()}`;
const destination = path.join(documentsRoot, documentId);
fs.mkdirSync(documentsRoot, { recursive: true });
fs.mkdirSync(destination);
for (const filename of ['index.html', 'styles.css']) {
  fs.copyFileSync(filename, path.join(destination, filename));
}
console.log(`[embed ref="${documentId}" title="交互参数" height="480" /]`);
```

Emit that printed shortcode as normal assistant text, outside a code fence.
Hosted refs need no external-URL switch.

## Existing website → URL embed

For “把 hao123 嵌入这条消息”, emit:

```text
[embed url="https://www.hao123.com/" title="hao123" height="640" /]
```

The host checks the Browser external-webpage setting. When blocked, provide the
normal link and explain the setting; do not enable it or clone the site into a ref.

## Compact self-contained card → show_widget

For a small local counter, discover the current `show_widget` and supply:

```json
{
  "title": "本地计数器",
  "kind": "html",
  "widget_code": "<div id='counter-demo'><button type='button'>增加一次</button><output aria-live='polite'>0</output></div><script>{const root=document.getElementById('counter-demo');let count=0;root.querySelector('button').addEventListener('click',()=>{root.querySelector('output').textContent=String(++count);});}</script>"
}
```

This call uses a fragment, local JavaScript and no network capabilities. The host
supplies its title and card controls. Use the native HTML reference only when
resource policy, links or the optional conversation draft action are needed.
