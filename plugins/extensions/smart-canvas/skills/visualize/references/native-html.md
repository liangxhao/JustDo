# Native HTML cards

Use `show_widget` for compact, self-contained cards or when the task needs the
conversation draft bridge. Complete pages, interactive 3D scenes and content
with normal external resource loading use hosted HTML instead.

## Source and native limits

Read the current tool schema. For `kind: "html"`, pass an HTML/SVG fragment with
optional inline CSS and JavaScript in `widget_code`; the host supplies the
frame and title. No chart or 3D library is preloaded. Use supplied data, system
fonts and inline assets for self-contained cards. Available theme variables
include `--font-body`, `--text`, `--muted`, `--card`, `--border`, `--accent-fill`
and `--accent-fg`.

The native sandbox permits inline scripts and selected CDN script/style/font
origins, but images must be data URLs and inline API connections are disabled.
An allowed script host does not authorize textures or `fetch`. Do not add pinning,
network grants or image conversion to render a webpage; choose the webpage
viewer before authoring. Native policies remain in force for existing documents.

Keep local controls and calculations inside the card. Scope IDs/styles, size
canvas/SVG to the container, and keep controls readable in both inline and
expanded views. Animations requested by the task stay active when the OS
requests reduced motion. Use `textContent` for external labels and user input.
Expanding or moving to the sidebar uses host controls and retains the document.

## Links

Real HTTP(S) `<a href>` activations open the current conversation's sidebar.
For search, update a real link's `href` from the input and let the user activate
it. `window.open()`, scripted clicks and external form navigation are unavailable
in Widgets. Page-like search forms belong in the webpage viewer. Local file
links belong in ordinary chat Markdown.

## Optional conversation draft

A real user-clicked control can call `openclaw.prompt.send(text)` to prepare a
suggestion. The host offers “加入草稿” / “Add to draft”; the user still sends it.
Listen for the parent policy message and capture/validate values synchronously
inside the trusted click. Keep text nonempty, within 4,000 UTF-16 code units and
free of leading slash or execution prefixes.

```html
<div id="discussion-example">
  <label>Value <input type="number" value="2" required></label>
  <button type="button" disabled>Discuss this value</button>
  <p role="alert"></p>
</div>
<script>
{
  const root = document.getElementById('discussion-example');
  const input = root.querySelector('input');
  const button = root.querySelector('button');
  const error = root.querySelector('[role=alert]');
  let available = false;
  let pending = false;
  const update = () => { button.disabled = !available || pending; };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'openclaw:scenario-draft-policy') return;
    available = event.data.available === true && typeof window.openclaw?.prompt?.send === 'function';
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
      const delivered = await openclaw.prompt.send(`Explain this selected value: ${value}.`);
      if (delivered === false) error.textContent = 'Could not prepare the suggestion.';
    } catch {
      error.textContent = 'Could not prepare the suggestion.';
    } finally {
      pending = false;
      update();
    }
  });
}
</script>
```

The policy message signals availability, not permission to execute a model turn.
The canonical bridge validates activation, visibility, focus and current session.
A receipt confirms local suggestion delivery, not model acceptance or completion.
Do not call it on load, in a timer or for each keystroke. After the user sends,
use their confirmed values when creating the next Widget through the real tool;
there is no invented inline update API. Keep labels/errors in the user's language.
