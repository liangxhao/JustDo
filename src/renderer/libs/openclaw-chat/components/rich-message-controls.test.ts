// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';

import { parseJsonSource, tableToTsv } from './json-source-tree';
import { RichMessageControls } from './rich-message-controls';
import { terminalSegments } from './terminal-output';
import { OUTPUT_PAGE_CHARS, outputPageRanges, ToolOutput } from './tool-output';

describe('source-preserving message readers', () => {
  test('distinguishes normal and bright ANSI colors on the dark terminal card', () => {
    const segments = terminalSegments('\x1b[31mred\x1b[91mbright\x1b[0mplain');
    expect(segments.map(segment => segment.color)).toEqual(['#f92672', '#ff6188', '']);
  });

  test('highlights plain PowerShell listings without changing their text or spacing', () => {
    const source =
      'C:\\Users\\demo\n\nMode    LastWriteTime     Length Name\n----    -------------    ------ ----\n-a--    2026/9/22 12:07   11630 SKILL.md\n';
    const segments = terminalSegments(source);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
    for (const kind of ['path', 'header', 'number', 'file', 'muted']) {
      expect(segments.some(segment => segment.color === `var(--terminal-${kind})`)).toBe(true);
    }
    expect(segments.find(segment => segment.text === 'SKILL.md')!.color).toBe(
      'var(--terminal-file)',
    );
  });

  test('renders terminal colors as safe text while copying the original output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const output = document.createElement('justdo-tool-output') as ToolOutput;
    output.terminal = true;
    output.text =
      '\x1b[31;1m<img src=x onerror=alert(1)>\x1b[0m\r\nMode    Name\r\n-a--    file.txt';
    document.body.append(output);
    await output.updateComplete;
    expect(output.querySelector('img')).toBeNull();
    expect(output.querySelector('pre')!.className).toBe('tool-output-terminal');
    expect(output.querySelectorAll('.tool-output-terminal-chrome span')).toHaveLength(3);
    expect(output.querySelector('.tool-output-terminal-chrome')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(output.querySelector('pre')!.textContent).toBe(
      '<img src=x onerror=alert(1)>\nMode    Name\n-a--    file.txt',
    );
    expect(output.querySelector('pre span')!.getAttribute('style')).toContain('#f92672');
    output.querySelector('button')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(output.text);
    output.remove();
  });
  test('strips terminal hyperlink and clear-screen controls without creating links', () => {
    const segments = terminalSegments('\x1b]8;;https://example.com\x07label\x1b]8;;\x07\x1b[2J');
    expect(segments.map(segment => segment.text).join('')).toBe('label');
  });
  test('paginates at lines and preserves surrogate pairs and CRLF without losing text', () => {
    for (const source of [
      'a'.repeat(9000) + '\n' + 'b'.repeat(9000),
      'a'.repeat(15999) + '😀tail',
      'a'.repeat(15999) + '\r\ntail',
    ]) {
      const ranges = outputPageRanges(source);
      const pages = ranges.map(([start, end]) => source.slice(start, end));
      expect(pages.join('')).toBe(source);
      expect(pages.every(page => page.length <= OUTPUT_PAGE_CHARS)).toBe(true);
      expect(pages[0]).not.toMatch(/[\uD800-\uDBFF\r]$/);
    }
    expect(outputPageRanges('a'.repeat(9000) + '\n' + 'b'.repeat(9000))[0][1]).toBe(9001);
  });
  test('short readers expose only copy and copy the exact source', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const output = document.createElement('justdo-tool-output') as ToolOutput;
    output.text = '  short output\n';
    document.body.append(output);
    await output.updateComplete;
    expect(output.querySelectorAll('button')).toHaveLength(1);
    expect(output.querySelector('.message-reader-actions')).toBeNull();
    const copy = output.querySelector('.tool-output-bubble > button')!;
    expect(copy.querySelector('svg')).not.toBeNull();
    expect(copy.getAttribute('aria-label')).toBeTruthy();
    expect(copy.textContent!.trim()).toBe('');
    expect(output.querySelector('pre')!.textContent).toBe(output.text);
    output.querySelector('button')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('  short output\n');
    output.remove();
  });
  test('keeps duplicate keys, large integers and escapes as exact source slices', () => {
    const source = '{"id":9007199254740993,"id":1e+30,"text":"a\\n"}';
    const tree = parseJsonSource(source)!;
    expect(tree.children!.map(node => [node.label, source.slice(node.start, node.end)])).toEqual([
      ['"id"', '9007199254740993'],
      ['"id"', '1e+30'],
      ['"text"', '"a\\n"'],
    ]);
  });
  test.each(['{"a":1,}', '[1,]', '{"a":', '{} trailing', '['.repeat(100) + ']'.repeat(100)])(
    'keeps invalid or complex JSON in source view: %s',
    source => {
      expect(parseJsonSource(source)).toBeNull();
    },
  );
  test.each(['\u00a0{}', '{\u00a0"key":1}', '[1,\v2]', '{}\f'])(
    'rejects non-JSON whitespace without replacing the raw source: %j',
    source => {
      expect(parseJsonSource(source)).toBeNull();
    },
  );
  test('accepts all four JSON whitespace characters around source values', () => {
    expect(parseJsonSource(' \t\r\n{"key": [\n1,\t2]}\r\n')).not.toBeNull();
  });
  test('quotes spreadsheet control characters and keeps visible link text', () => {
    const table = document.createElement('table');
    table.innerHTML =
      '<tr><td>a\tb</td><td>line\n&quot;quoted&quot;</td><td><a href="https://example.test">link</a></td></tr>';
    expect(tableToTsv(table)).toBe('"a\tb"\t"line\n""quoted"""\tlink');
  });
  test('retains code preferences through DOM replacement but clears them on session switch', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const source =
      '<div data-group-key="entry"><div class="code-block-wrapper"><div class="code-block-header"></div><pre><code>  text\n</code></pre></div></div>';
    root.innerHTML = source;
    const controls = new RichMessageControls(root, vi.fn());
    controls.reset('one');
    controls.sync();
    root.querySelectorAll<HTMLButtonElement>('.message-reader-actions button')[1].click();
    expect(root.querySelector('.is-wrapped')).not.toBeNull();
    root.innerHTML = source;
    controls.sync();
    expect(root.querySelector('.is-wrapped')).not.toBeNull();
    controls.reset('two');
    root.innerHTML = source;
    controls.sync();
    expect(root.querySelector('.is-wrapped')).toBeNull();
    root.remove();
  });
  test('bounds a 2 MB output and reports copy failure without success feedback', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const output = document.createElement('justdo-tool-output') as ToolOutput;
    output.text = 'x'.repeat(2_000_000) + '\n';
    document.body.append(output);
    await output.updateComplete;
    expect(output.querySelector('pre')!.textContent!.length).toBe(OUTPUT_PAGE_CHARS);
    output.querySelector<HTMLButtonElement>('button')!.click();
    await Promise.resolve();
    await output.updateComplete;
    expect(output.querySelector('[role=status]')!.textContent).not.toBe('');
    output.remove();
  });
});

test('selection context menu offers copy and explicitly enabled quote actions', async () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-assistant-entry="entry"><div class="chat-bubble__text">quoted text</div></div>';
  document.body.append(root);
  const controls = new RichMessageControls(root, vi.fn());
  controls.reset('session');
  const range = document.createRange();
  range.selectNodeContents(root.querySelector('.chat-bubble__text')!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  expect(root.querySelector('.message-selection-actions')).toBeNull();
  const onQuote = vi.fn();
  controls.onQuote = onQuote;
  root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  expect(root.querySelector('.message-selection-actions')).toBeNull();
  root
    .querySelector('[data-assistant-entry]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(root.querySelectorAll('[role=menuitem]')).toHaveLength(3);
  expect(onQuote).not.toHaveBeenCalled();
  root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[1].click();
  expect(onQuote).toHaveBeenCalledWith(
    expect.objectContaining({ sessionKey: 'session', entryId: 'entry', text: 'quoted text' }),
    'composer',
  );
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  const body = root.querySelector('.chat-bubble__text')!;
  const selectAgain = () => {
    const selected = document.createRange();
    selected.selectNodeContents(body);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(selected);
  };
  selectAgain();
  body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(root.querySelector('[role=menu]')).toBeNull();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  controls.onQuote = undefined;
  selectAgain();
  body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(root.querySelectorAll('[role=menuitem]')).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('[role=menuitem]')!.click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith('quoted text');
  expect(root.querySelector('[role=menu]')).toBeNull();
  selectAgain();
  body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  controls.reset('next-session');
  expect(root.querySelector('[role=menu]')).toBeNull();
  const navigation = new KeyboardEvent('keydown', {
    key: 'Home',
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(navigation);
  expect(navigation.defaultPrevented).toBe(false);
  selectAgain();
  body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(root.querySelector('[role=menu]')).toBeNull();
  controls.dispose();
  root.remove();
});
test('ignores a late output response after the reader is closed and permits retry', async () => {
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  output.partial = true;
  output.identity = { runId: 'r', toolCallId: 't', messageId: 'm' };
  output.text = 'partial';
  document.body.append(output);
  await output.updateComplete;
  let request: { complete: (text: string) => void; isCurrent: () => boolean } | undefined;
  output.addEventListener('tool-output-request', event => {
    request = (event as CustomEvent).detail;
  });
  output.querySelectorAll<HTMLButtonElement>('button')[2].click();
  await output.updateComplete;
  expect(request!.isCurrent()).toBe(true);
  output.cancelLoad();
  request!.complete('wrong late output');
  await output.updateComplete;
  expect(output.text).toBe('partial');
  expect(output.querySelectorAll<HTMLButtonElement>('button')[2].disabled).toBe(false);
  output.remove();
});

test('expanded table links close the dialog and use the original link action', () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  const root = document.createElement('div');
  root.innerHTML =
    '<div class="markdown-table-scroll"><table><tr><td><a href="https://example.test">source</a></td></tr></table></div>';
  document.body.append(root);
  const clicked = vi.fn((event: Event) => event.preventDefault());
  root.querySelector('a')!.addEventListener('click', clicked);
  const controls = new RichMessageControls(root, vi.fn());
  controls.sync();
  root.querySelectorAll<HTMLButtonElement>('button')[1].click();
  root.querySelector<HTMLAnchorElement>('dialog a')!.click();
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(root.querySelector('dialog')).toBeNull();
  controls.dispose();
  root.remove();
});

test('offers quote actions for the latest live reply without inventing a history entry ID', () => {
  const root = document.createElement('div');
  root.innerHTML = '<div data-quote-source><div class="chat-bubble__text">latest reply</div></div>';
  document.body.append(root);
  const controls = new RichMessageControls(root, vi.fn());
  controls.reset('session');
  controls.onQuote = vi.fn();
  const range = document.createRange();
  range.selectNodeContents(root.querySelector('.chat-bubble__text')!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  root
    .querySelector('[data-quote-source]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(root.querySelectorAll('[role=menuitem]')).toHaveLength(3);
  root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[1].click();
  expect(controls.onQuote).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'latest reply', entryId: '', sessionKey: 'session' }),
    'composer',
  );
  controls.dispose();
  root.remove();
});

test('opens on the final historical message when selection ends outside its wrapper', () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-assistant-entry="previous">earlier</div><div data-assistant-entry="last"><div class="chat-bubble__text"><p>last historical reply</p></div></div>';
  document.body.append(root);
  const controls = new RichMessageControls(root, vi.fn());
  controls.reset('history');
  controls.onQuote = vi.fn();
  const range = document.createRange();
  range.setStart(root.querySelector('p')!.firstChild!, 0);
  range.setEnd(root, root.childNodes.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  root
    .querySelector('p')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(root.querySelectorAll('[role=menuitem]')).toHaveLength(3);
  root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[1].click();
  expect(controls.onQuote).toHaveBeenCalledWith(
    expect.objectContaining({ entryId: 'last', text: 'last historical reply' }),
    'composer',
  );
  controls.dispose();
  root.remove();
});

test('Mermaid uses icon actions and a close-only zoomable draggable dialog', () => {
  const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const root = document.createElement('div');
  root.innerHTML =
    '<div class="code-block-wrapper mermaid-block"><div class="code-block-header"></div><svg viewBox="0 0 100 100"><text>diagram</text></svg><pre><code>graph LR</code></pre></div>';
  document.body.append(root);
  const controls = new RichMessageControls(root, vi.fn());
  controls.sync();
  const actions = root.querySelectorAll<HTMLButtonElement>('.message-reader-actions button');
  expect(actions).toHaveLength(3);
  expect(
    [...actions].every(button => button.querySelector('svg') && button.getAttribute('aria-label')),
  ).toBe(true);
  actions[1].click();
  const dialog = root.querySelector('dialog')!;
  expect(dialog.querySelectorAll('button')).toHaveLength(1);
  const viewport = dialog.querySelector<HTMLElement>('.message-mermaid-viewport')!;
  const svg = viewport.querySelector('svg')!;
  viewport.dispatchEvent(
    new WheelEvent('wheel', { deltaY: -100, clientX: 50, clientY: 50, cancelable: true }),
  );
  expect(svg.style.transform).toContain('scale(1.22');
  viewport.setPointerCapture = vi.fn();
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    viewport.dispatchEvent(event);
  };
  const before = svg.style.transform;
  pointer('pointerdown', 10, 10);
  pointer('pointermove', 40, 30);
  pointer('pointerup', 40, 30);
  expect(svg.style.transform).not.toBe(before);
  expect(viewport.classList.contains('is-dragging')).toBe(false);
  dialog.querySelector('button')!.click();
  expect(root.querySelector('dialog')).toBeNull();
  controls.dispose();
  root.remove();
  show.mockRestore();
});

test('groups JSON copy and all reading actions as labeled icons in one header toolbar', () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<div class="code-block-wrapper"><div class="code-block-header"><span>json</span><button class="code-block-copy" data-code="{}">copy</button></div><pre><code>{}</code></pre></div>';
  const controls = new RichMessageControls(root, vi.fn());
  controls.sync();
  const header = root.querySelector('.code-block-header')!;
  expect(header.querySelector('.code-block-copy')).toBeNull();
  const buttons = header.querySelectorAll('.message-reader-actions button');
  expect(buttons).toHaveLength(5);
  expect(
    [...buttons].every(
      button =>
        button.querySelector('svg') &&
        button.getAttribute('aria-label') &&
        !button.textContent?.trim(),
    ),
  ).toBe(true);
  controls.dispose();
});
