// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { OUTPUT_PAGE_CHARS, TOOL_OUTPUT_REQUEST, type ToolOutput } from './tool-output';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('shows one terminal card with the literal command and the subsequently received output', async () => {
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  output.terminal = true;
  output.terminalCommand = 'printf "<prefix>\n"';
  document.body.append(output);
  await output.updateComplete;

  const card = output.querySelector('.tool-output-bubble');
  expect(card?.querySelectorAll('.tool-output-terminal-chrome span')).toHaveLength(3);
  expect(card?.querySelector('[data-tool-search-source="exec-command"]')?.textContent)
    .toBe(output.terminalCommand);
  expect(card?.querySelector('.tool-output-terminal')).toBeNull();

  output.text = '\x1b[32mresult\x1b[0m';
  await output.updateComplete;

  expect(output.querySelector('.tool-output-bubble')).toBe(card);
  expect(card?.querySelector('.tool-output-terminal')?.textContent).toBe('result');
});

test('shows an empty Exec result without offering to copy the placeholder', async () => {
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  output.terminal = true;
  output.terminalCommand = 'exit 0';
  output.showEmptyResult = true;
  document.body.append(output);
  await output.updateComplete;

  expect(output.querySelector('.tool-output-terminal')?.textContent)
    .toBe(i18nService.t('coworkToolNoOutput'));
  expect(output.querySelector('.tool-output-copy')).toBeNull();
  expect(output.resultText).toBe('');
});

test('retains a pending output read across equivalent identities and cancels on a changed result', async () => {
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  const identity = { runId: 'run', toolCallId: 'call', messageId: 'original' };
  const render = vi.spyOn(output, 'render');
  const onRead = vi.fn();
  output.identity = identity;
  output.terminal = true;
  output.paginate = false;
  output.text = 'partial output';
  output.partial = true;
  output.addEventListener(TOOL_OUTPUT_REQUEST, onRead);
  document.body.append(output);
  await output.updateComplete;

  const actions = output.querySelectorAll<HTMLButtonElement>('.message-reader-actions button');
  expect(actions).toHaveLength(1);
  expect(actions[0].textContent?.trim()).toBe(i18nService.t('messageFullOutput'));
  actions[0].click();
  await output.updateComplete;
  const request = (onRead.mock.calls[0][0] as CustomEvent<{
    isCurrent(): boolean;
    complete(result: string): void;
  }>).detail;
  render.mockClear();

  output.identity = { ...identity };
  await output.updateComplete;
  expect(render).not.toHaveBeenCalled();
  expect(request.isCurrent()).toBe(true);

  output.identity = { ...identity, messageId: 'replacement' };
  await output.updateComplete;
  expect(render).toHaveBeenCalledTimes(1);
  expect(request.isCurrent()).toBe(false);
  request.complete('stale result');
  expect(output.resultText).toBe('partial output');
});

test('shows long Exec commands and results in full without download or pagination buttons', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    const command = `const code = "${'x'.repeat(OUTPUT_PAGE_CHARS)}";\nreturn code;`;
    const result = `match\n${'plain output\n'.repeat(1500)}\x1b[32mmatch\x1b[0m`;
    const output = document.createElement('justdo-tool-output') as ToolOutput;
    output.terminal = true;
    output.terminalCommand = command;
    output.terminalCommandLanguage = 'javascript';
    output.paginate = false;
    output.text = result;
    document.body.append(output);
    await output.updateComplete;

    const commandView = output.querySelector('.tool-output-terminal-command');
    const resultView = output.querySelector('.tool-output-terminal');
    expect(commandView?.textContent).toBe(command);
    expect(resultView?.textContent).toBe(result.replace(/\x1b\[\d+m/g, ''));
    expect(resultView?.querySelector('span')?.textContent).toBe('match');
    expect(output.querySelector('.message-reader-actions')).toBeNull();
    expect(output.prepareCommandSearch('return', true, 0)).toEqual({ element: commandView, occurrence: 0 });
    expect(output.prepareSearch('match', true, 1)).toEqual({ count: 2, occurrence: 1 });
    output.querySelector<HTMLButtonElement>('.tool-output-command-copy')!.click();
    output.querySelector<HTMLButtonElement>('.tool-output-copy:not(.tool-output-command-copy)')!.click();
    expect(writeText.mock.calls).toEqual([[command], [output.text]]);
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

test('Write text can be clipped, independently revealed from search, and collapsed again', async () => {
  let resize: () => void = () => undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const text = 'export default config;\n'.repeat(11) + 'uniqueTail';
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  output.text = text;
  output.collapsible = true;
  document.body.append(output);
  await output.updateComplete;
  const preview = output.querySelector('pre')!;
  preview.style.lineHeight = '18px';
  vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);

  const height = vi.spyOn(preview, 'scrollHeight', 'get').mockReturnValue(180);
  resize();
  await output.updateComplete;
  expect(output.querySelector('.tool-output-preview-toggle')).toBeNull();

  height.mockReturnValue(218);
  resize();
  await output.updateComplete;
  const toggle = output.querySelector<HTMLButtonElement>('.tool-output-preview-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(preview.hasAttribute('data-preview-collapsed')).toBe(true);

  expect(output.prepareSearch('uniqueTail', true, 0)).toEqual({ count: 1, occurrence: 0 });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(preview.hasAttribute('data-preview-collapsed')).toBe(false);
  expect(preview.textContent).toBe(text);

  toggle.click();
  await output.updateComplete;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(preview.hasAttribute('data-preview-collapsed')).toBe(true);
});

test('Write editor highlights its page and continues line numbering without adding text to the source', async () => {
  const line = '// ' + 'x'.repeat(76) + '\n';
  const tail = 'const needle = "<safe>";\n';
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  output.text = line.repeat(200) + tail;
  output.language = 'typescript';
  output.collapsible = true;
  output.editorStyle = true;
  document.body.append(output);
  await output.updateComplete;

  const pane = output.querySelector('.tool-output-bubble--editor')!;
  const gutter = () => pane.querySelector<HTMLElement>('.tool-output-code-gutter')!;
  expect(gutter().dataset.lineNumbers).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10');
  expect(gutter().getAttribute('aria-hidden')).toBe('true');
  expect(pane.querySelector('pre')?.textContent).toBe(line.repeat(200));

  expect(output.prepareSearch('needle', true, 0)).toEqual({ count: 1, occurrence: 0 });
  expect(gutter().dataset.lineNumbers).toBe('201');
  expect(pane.querySelector('.hljs-keyword')?.textContent).toBe('const');
  expect(pane.querySelector('pre')?.textContent).toBe(tail);
  expect(pane.querySelector('.tool-output-preview-toggle')?.getAttribute('aria-expanded')).toBe('true');
});

test('Write editor keeps the disclosure when its horizontal scrollbar clips a preview line', async () => {
  let resize: () => void = () => undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const output = document.createElement('justdo-tool-output') as ToolOutput;
  output.text = ('x'.repeat(80) + '\n').repeat(10);
  output.collapsible = true;
  output.editorStyle = true;
  document.body.append(output);
  await output.updateComplete;

  const preview = output.querySelector('pre')!;
  preview.style.lineHeight = '18px';
  preview.style.padding = '8px 40px 6px 10px';
  vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);
  const offsetHeight = vi.spyOn(preview, 'offsetHeight', 'get').mockReturnValue(194);
  const clientHeight = vi.spyOn(preview, 'clientHeight', 'get').mockReturnValue(184);
  vi.spyOn(preview, 'scrollHeight', 'get').mockReturnValue(194);
  resize();
  await output.updateComplete;

  const toggle = output.querySelector<HTMLButtonElement>('.tool-output-preview-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  offsetHeight.mockReturnValue(204);
  clientHeight.mockReturnValue(194);
  toggle.click();
  await output.updateComplete;

  expect(output.querySelector('.tool-output-preview-toggle')).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});
