# Native HTML interactions

Use only the current turn's advertised `show_widget` HTML kind. Supply a short
`title` and the markup string in `widget_code`; let the host display the title.
Start with useful content, not another heading or card frame. Use `--font-body`,
`--text`, `--muted`, `--card`, `--border`, `--accent-fill` and `--accent-fg`.
Keep controls responsive, label inputs, and make local computations deterministic.
Give the content consistent padding and use the available width; do not leave a
narrow form against the card edge. Prefer a `type="button"` click handler for the
primary action, validate inputs synchronously, and await the bridge result.
No external API calls, invented facts, native paths or dashboard grants.

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
- Start with the useful content. Use one primary action only when needed;
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

A compact example for this host (replace the example goal and units with the
user's actual request):

```html
<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--text); background: transparent;
    font-family: var(--font-body, system-ui, sans-serif); font-size: 14px; line-height: 1.5; }
  main { padding: clamp(16px, 3vw, 24px); min-width: 0; overflow-wrap: anywhere; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  label { display: grid; min-width: 0; gap: 8px; }
  input, select, textarea, button { font: inherit; }
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea {
    width: 100%; min-width: 0; min-height: 40px; padding: 10px; color: inherit;
    background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  input:is([type="checkbox"], [type="radio"], [type="range"]) { accent-color: var(--accent-fill); }
  .actions { display: flex; justify-content: flex-end; margin-top: 20px; }
  button { min-height: 40px; max-width: 100%; padding: 9px 16px; border: 0; border-radius: 8px;
    background: var(--accent-fill); color: var(--accent-fg); cursor: pointer; white-space: normal; }
  :is(input, select, textarea, button):focus-visible { outline: 2px solid var(--accent-fill); outline-offset: 3px; }
  button:disabled { opacity: .45; cursor: default; }
  #error { color: var(--danger, var(--text)); font-size: 13px; margin: 12px 0 0; }
  @media (max-width: 480px) { .fields { grid-template-columns: minmax(0, 1fr); } }
</style>
<main>
  <label>Budget (CNY)<input id="budget" type="number" min="1" max="1000000" required value="5000"></label>
  <p id="error" role="alert" hidden></p>
  <div class="actions"><button id="follow" type="button" disabled>Continue analysis</button></div>
</main>
<script>
  const input = document.getElementById('budget');
  const button = document.getElementById('follow');
  const error = document.getElementById('error');
  let available = false;
  let pending = false;
  const showError = text => { error.textContent = text; error.hidden = !text; };
  const update = () => { button.disabled = !available || pending; };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'openclaw:scenario-draft-policy') return;
    available = event.data.available === true && typeof window.openclaw?.prompt?.send === 'function';
    update();
  });
  button.addEventListener('click', async event => {
    if (!event.isTrusted || !available || pending) return;
    if (!input.reportValidity()) return;
    const budget = input.valueAsNumber;
    // Capture and validate synchronously, while the native activation is current.
    pending = true;
    showError('');
    update();
    try {
      const prepared = await openclaw.prompt.send(
        `Please reassess the plan using this user-selected budget: ${budget} CNY.`
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
