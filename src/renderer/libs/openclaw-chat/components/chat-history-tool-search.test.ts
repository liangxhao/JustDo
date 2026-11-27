/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { ChatScrollController } from '../controllers/chat-scroll-controller';
import { beginAssistantTurn, createChatTranscriptState, type ToolItem } from '../model/chat-transcript-state';
import type { GatewayMessage } from '../types';
import type { JustDoChatElement } from './justdo-chat';
import type { ToolOutput } from './tools/tool-output';

const selectNativeEditRange = vi.hoisted(() => vi.fn());

vi.mock('@/shared/dom/observeEditorLayout', () => ({ observeEditorLayout: () => () => {} }));
vi.mock('@/shared/editor/monaco', () => ({
  monaco: {
    Uri: { parse: (uri: string) => uri },
    editor: {
      defineTheme() {},
      createModel: () => ({ dispose() {} }),
      createDiffEditor: () => ({
        createViewModel: () => ({ dispose() {} }),
        setModel() {},
        dispose() {},
        getModifiedEditor: () => ({ setSelection: selectNativeEditRange, revealRangeInCenter() {} }),
      }),
    },
  },
}));

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(ChatScrollController.prototype, 'navigateToElement').mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  selectNativeEditRange.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function toolHistory(input: unknown, output: string, name = 'read'): Promise<JustDoChatElement> {
  const messages: GatewayMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'read-call', name, arguments: input }],
      __openclaw: { id: 'read-entry' },
    },
    {
      role: 'toolResult',
      toolCallId: 'read-call',
      toolName: name,
      content: output,
      __openclaw: { id: 'read-result' },
    },
    { role: 'assistant', content: 'Done', __openclaw: { id: 'final' } },
  ];
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = messages;
  document.body.append(chat);
  await chat.updateComplete;
  return chat;
}

async function liveTool(
  name: string,
  input: unknown,
  result: Partial<Pick<ToolItem, 'output' | 'presentation' | 'progressText' | 'status'>> = {},
): Promise<JustDoChatElement> {
  const turn = beginAssistantTurn(
    createChatTranscriptState('tool-search-fixture'),
    { runId: 'live-run' },
    { now: () => 1_000, createId: prefix => prefix },
  );
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.activeTurn = { ...turn, lastAgentSeq: 1, items: [{
    type: 'tool', id: 'live-tool', toolCallId: 'live-call', runId: 'live-run', name, input,
    status: 'running', firstSeq: 1, lastSeq: 1, startedAt: 1_000, updatedAt: 1_000, ...result,
  }] };
  chat.isStreaming = true;
  document.body.append(chat);
  await chat.updateComplete;
  return chat;
}

function highlightedSource(chat: JustDoChatElement) {
  const mark = chat.shadowRoot!.querySelector<HTMLElement>('.chat-search-mark');
  expect(mark).not.toBeNull();
  expect(mark!.closest('.process-summary__tool-title, .process-summary__detail-label')).toBeNull();
  const reader = mark!.closest<ToolOutput>('justdo-tool-output');
  expect(reader).not.toBeNull();
  const pre = mark!.closest('pre')!;
  const before = document.createRange();
  before.selectNodeContents(pre);
  before.setEndBefore(mark!);
  return {
    text: reader!.text,
    output: mark!.closest('.process-summary__tool-result') !== null,
    offset: before.toString().length,
  };
}

test('navigates indexed tool input and output instead of duplicate summary text', async () => {
  const chat = await toolHistory({ path: 'needle.txt' }, 'needle output');
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);

  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(highlightedSource(chat)).toMatchObject({
    output: false,
    text: JSON.stringify({ path: 'needle.txt' }, null, 2),
  });
  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  expect(highlightedSource(chat)).toMatchObject({ output: true, text: 'needle output' });
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(highlightedSource(chat).output).toBe(false);
});

test('finds Exec command and output in the collapsed row and opens only for a raw-only argument', async () => {
  const chat = await toolHistory({ command: 'echo needle', cwd: 'native-needle-workdir' }, '\u001b[32mneedle\u001b[0m', 'exec');
  chat.searchQuery = 'needle';
  await chat.updateComplete;

  expect(chat.getSearchMatchCount()).toBe(3);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 3 });
  const root = chat.shadowRoot!;
  expect(root.querySelector('[data-tool-search-source="exec-command"] .chat-search-mark')?.textContent).toBe('needle');
  const details = root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('[data-tool-search-source="raw-input"]')).toBeNull();
  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 3 });
  expect(root.querySelector('pre.tool-output-terminal .chat-search-mark')?.textContent).toBe('needle');
  expect(details.open).toBe(false);

  expect(chat.navigateSearch(1)).toEqual({ index: 2, total: 3 });
  expect(details.open).toBe(true);
  expect(root.querySelector('[data-tool-search-source="raw-input"] .chat-search-mark')?.previousSibling?.textContent)
    .toContain('"cwd": "native-');
});

test('finds one terminal hit and one raw-only hit for a saved Exec result', async () => {
  const output = '\u001b]0;terminal-token\u0007terminal-token';
  const chat = await toolHistory({ command: 'run' }, output, 'exec');
  chat.searchQuery = 'terminal-token';
  await chat.updateComplete;
  const root = chat.shadowRoot!;

  expect(chat.getSearchMatchCount()).toBe(2);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(root.querySelector('pre.tool-output-terminal .chat-search-mark')?.textContent).toBe(chat.searchQuery);
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);

  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  const mark = root.querySelector('[data-tool-search-source="raw-result"] .chat-search-mark');
  expect(mark?.textContent).toBe(chat.searchQuery);
  expect(mark?.nextSibling?.textContent).toBe('\u0007terminal-token');
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(true);
});

test('deduplicates only the mirrored Exec command on the currently displayed live raw page', async () => {
  const chat = await liveTool('exec', { padding: 'x'.repeat(17_000), command: 'echo needle', cwd: 'needle-workdir' });
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);

  const details = chat.shadowRoot!.querySelector<HTMLDetailsElement>('details[data-tool-identity]')!;
  const reader = details.querySelector<ToolOutput>('[data-tool-search-source="raw-input"]')!;
  details.open = true;
  await reader.updateComplete;
  const next = [...reader.querySelectorAll<HTMLButtonElement>('.message-reader-actions button')]
    .find(button => button.textContent?.trim() === i18nService.t('messageNext'))!;
  next.click();
  await reader.updateComplete;

  expect(chat.getSearchMatchCount()).toBe(2);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(reader.querySelector('.chat-search-mark')?.nextSibling?.textContent).toContain('-workdir');
  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  expect(chat.shadowRoot!.querySelector('[data-tool-search-source="exec-command"] .chat-search-mark')?.textContent)
    .toBe('needle');
});

test('ignores the synthetic result placeholder when searching a live completed Exec', async () => {
  const empty = await liveTool('exec', { command: 'echo' }, { status: 'completed' });
  empty.searchQuery = i18nService.t('coworkToolNoOutput');
  await empty.updateComplete;
  empty.getSearchMatchCount();
  const emptyRaw = empty.shadowRoot!.querySelector<ToolOutput>('[data-tool-search-source="raw-result"]')!;
  await emptyRaw.updateComplete;
  expect(emptyRaw.querySelector('[data-tool-search-placeholder]')?.textContent).toContain(empty.searchQuery);
  expect(empty.getSearchMatchCount()).toBe(0);
});

test('counts recovered live Exec output once after replacing distinct progress and raw results', async () => {
  const chat = await liveTool('exec', { command: 'check progress' }, {
    output: 'Earlier summary',
    progressText: 'Current summary',
    presentation: { partial: true, resultMessageId: 'partial-result' },
  });
  chat.searchQuery = 'summary';
  await chat.updateComplete;
  chat.getSearchMatchCount();
  const raw = chat.shadowRoot!.querySelector<ToolOutput>('[data-tool-search-source="raw-result"]')!;
  await raw.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);

  raw.resultScope!.complete('Recovered summary');
  const inline = chat.shadowRoot!.querySelector<ToolOutput>('[data-tool-search-source="exec-result"]')!;
  await Promise.all([raw.updateComplete, inline.updateComplete]);
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(inline.querySelector('.chat-search-mark')?.textContent).toBe('summary');
});

test('locates late Exec output in the continuous terminal and counts mirrored raw hits once', async () => {
  const output = '\u001b[32mfirst output hit\u001b[0m\n' + 'progress output\n'.repeat(1_100) +
    'later output hit\n\u001b]0;terminal-token\u0007terminal-token';
  const chat = await liveTool('exec', { command: 'run' }, { output, status: 'completed' });
  const root = chat.shadowRoot!;
  const terminal = root.querySelector('pre.tool-output-terminal')!;
  const details = root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')!;
  const navigate = vi.mocked(ChatScrollController.prototype.navigateToElement);

  chat.searchQuery = 'first output hit';
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(terminal.querySelector('.chat-search-mark')?.textContent).toBe(chat.searchQuery);
  expect(details.open).toBe(false);

  details.querySelector<HTMLElement>('summary')!.click();
  const raw = details.querySelector<ToolOutput>('[data-tool-search-source="raw-result"]')!;
  await raw.updateComplete;
  const next = [...raw.querySelectorAll<HTMLButtonElement>('.message-reader-actions button')]
    .find(button => button.textContent?.trim() === i18nService.t('messageNext'))!;
  next.click();
  await raw.updateComplete;
  expect(raw.querySelector('pre')?.textContent).toContain('later output hit');

  chat.searchQuery = 'later output hit';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const mark = terminal.querySelector('.chat-search-mark');
  expect(mark?.textContent).toBe(chat.searchQuery);
  expect(navigate).toHaveBeenLastCalledWith(mark, 'smooth');
  expect(raw.querySelector('.chat-search-mark')).toBeNull();

  chat.searchQuery = 'terminal-token';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(raw.querySelector('.chat-search-mark')?.nextSibling?.textContent).toContain('\u0007');
  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  expect(terminal.querySelector('.chat-search-mark')?.textContent).toBe(chat.searchQuery);
});

test.each(['live.txt', 'live.ts'])('opens clipped live Write content before scrolling in %s', async path => {
  const query = 'visibleAfterExpand';
  const chat = await liveTool('write', { path, content: 'const entry = 0;\n'.repeat(11) + `const ${query} = 0;` });
  chat.searchQuery = query;
  await chat.updateComplete;
  const reader = chat.shadowRoot!.querySelector<ToolOutput>('[data-tool-search-source="write"]')!;
  expect(reader.querySelector('[data-preview-collapsed]')).not.toBeNull();
  const navigate = vi.mocked(ChatScrollController.prototype.navigateToElement).mockImplementation(mark => {
    expect(reader.querySelector('[data-preview-collapsed]')).toBeNull();
    expect(mark.isConnected).toBe(true);
    expect(mark.textContent).toBe(query);
  });

  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(reader.querySelector('.chat-search-mark')?.textContent).toBe(query);
  expect(chat.shadowRoot!.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);
});

test('reveals a later page of Write content without opening the raw tool details', async () => {
  const content = 'first line\n' + 'x'.repeat(17_000) + '\nlater-write-hit';
  const chat = await toolHistory({ path: 'long.txt', content }, 'Successfully wrote long.txt', 'write');
  chat.searchQuery = 'later-write-hit';
  await chat.updateComplete;

  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const root = chat.shadowRoot!;
  const inline = root.querySelector('[data-tool-search-source="write"]')!;
  expect(inline.querySelector('.chat-search-mark')?.textContent).toBe('later-write-hit');
  expect(inline.querySelector('.message-reader-actions')?.textContent).toContain('2 / 2');
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);
});

test('locates a hit at the end of a long Exec command alongside the current output', async () => {
  const fullCommand = 'x'.repeat(17_000) + 'later-command-hit';
  const chat = await toolHistory({ command: fullCommand }, 'Exact output', 'exec');
  chat.searchQuery = 'later-command-hit';
  await chat.updateComplete;

  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const root = chat.shadowRoot!;
  const command = root.querySelector('[data-tool-search-source="exec-command"]')!;
  const mark = command.querySelector('.chat-search-mark');
  expect(mark?.textContent).toBe('later-command-hit');
  expect(command.textContent).toBe(fullCommand);
  expect(ChatScrollController.prototype.navigateToElement).toHaveBeenLastCalledWith(mark, 'smooth');
  expect(root.querySelector('pre.tool-output-terminal')?.textContent?.trim()).toBe('Exact output');
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);
});

test('reveals a history message while keeping closed tool arguments unmaterialized', async () => {
  const chat = await toolHistory({ command: 'echo preview' }, 'Completed', 'exec');

  expect(chat.revealMessage('final')).toBe(true);

  expect(chat.shadowRoot!.querySelector('[data-tool-search-source="exec-result"]')).not.toBeNull();
  expect(chat.shadowRoot!.querySelector('[data-tool-search-source="raw-input"]')).toBeNull();
});

test('keeps repeated tool occurrences ordered when the query also matches translated labels', async () => {
  const query = i18nService.t('coworkToolInput');
  const input = { path: `${query} ${query}.txt` };
  const output = `${query} ${query}`;
  const chat = await toolHistory(input, output);
  chat.searchQuery = query;
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(4);

  const sources = [];
  for (let index = 0; index < 5; index += 1) {
    expect(chat.navigateSearch(1)).toEqual({ index: index % 4, total: 4 });
    sources.push(highlightedSource(chat));
  }
  expect(sources.map(source => source.output)).toEqual([false, false, true, true, false]);
  expect(sources[0].offset).toBeLessThan(sources[1].offset);
  expect(sources[2].offset).toBeLessThan(sources[3].offset);
  expect(sources[4]).toEqual(sources[0]);
});

test('highlights an offscreen tool output on the first navigation after its reader mounts', async () => {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = Array.from({ length: 100 }, (_, index): GatewayMessage[] => [
    { role: 'user', content: `Question ${index}`, __openclaw: { id: `user-${index}` } },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `read-${index}`, name: 'read', arguments: { path: `file-${index}.txt` } }],
      __openclaw: { id: `call-${index}` },
    },
    {
      role: 'toolResult', toolCallId: `read-${index}`, toolName: 'read',
      content: `Unique output token ${index}.`, __openclaw: { id: `result-${index}` },
    },
    { role: 'assistant', content: `Done ${index}`, __openclaw: { id: `final-${index}` } },
  ]).flat();
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('[data-entry-id="user-0"]')).toBeNull();

  chat.searchQuery = 'Unique output token 0.';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(highlightedSource(chat)).toMatchObject({ output: true, text: 'Unique output token 0.' });
});

test('selects the bounded output page containing a later search hit', async () => {
  const output = `${'x'.repeat(17_000)}needle on a later page`;
  const chat = await toolHistory({ path: 'file.txt' }, output);
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(highlightedSource(chat)).toMatchObject({ output: true, text: output });
  const pre = chat.shadowRoot!.querySelector('.chat-search-mark')!.closest('pre')!;
  expect(pre.textContent!.length).toBeLessThanOrEqual(16_001);
  expect(pre.textContent).not.toContain('x'.repeat(16_000));
});

test('keeps a search hit spanning an output page boundary in one bounded view', async () => {
  const query = 'needle-boundary';
  const chat = await toolHistory({ path: 'file.txt' }, `${'x'.repeat(15_995)}${query}${'y'.repeat(1_000)}`);
  chat.searchQuery = query;
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const mark = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  expect(mark.textContent).toBe(query);
  expect(mark.closest('pre')!.textContent!.length).toBeLessThanOrEqual(16_001 + query.length);
});

test('keeps global non-overlapping occurrence order when a previous hit crosses the page edge', async () => {
  const chat = await toolHistory({ path: 'file.txt' }, `${'x'.repeat(15_999)}ababababa`);
  chat.searchQuery = 'aba';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  const first = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  expect(first.textContent).toBe('aba');
  const firstText = first.closest('pre')!.textContent!.trimStart();
  expect(firstText.length).toBe(16_002);
  expect(firstText.endsWith('aba')).toBe(true);

  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  const second = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  expect(second.textContent).toBe('aba');
  // The previous full-source hit consumes the first two page characters.
  // The second hit is the first "aba" in this remaining, bounded snippet.
  expect(second.closest('pre')!.textContent!.trimStart()).toBe('bababa');
  expect(highlightedSource(chat).offset).toBe(1);
  const reader = second.closest<ToolOutput>('justdo-tool-output')!;
  chat.searchQuery = '';
  await chat.updateComplete;
  expect(reader.querySelector('pre')!.textContent!.trimStart()).toBe('babababa');
  expect(reader.querySelector('.chat-search-mark')).toBeNull();
});

test.each(['unified', 'split'])(
  'searches native Edit code and output in source order in %s mode',
  async mode => {
    const chat = await toolHistory({
      path: 'file.txt',
      old_string: 'old needle first\nold needle second',
      new_string: 'new needle first\nnew needle second',
    }, 'needle output', 'edit');
    chat.searchQuery = 'needle';
    await chat.updateComplete;
    expect(chat.getSearchMatchCount()).toBe(5);
    // Materialize the native Edit presentation before choosing its display mode.
    chat.navigateSearch(1);
    expect(chat.shadowRoot!.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);
    if (mode === 'split') {
      const split = [...chat.shadowRoot!.querySelectorAll<HTMLButtonElement>('.edit-diff__mode-button')]
        .find(button => button.getAttribute('aria-label') === i18nService.t('coworkEditDiffSplitMode'))!;
      split.click();
      await chat.updateComplete;
    }
    // Continue at the second old line, then both new lines, the output and wrap.
    const texts = ['old needle second', 'new needle first', 'new needle second', null, 'old needle first'];
    for (let index = 0; index < texts.length; index += 1) {
      expect(chat.navigateSearch(1)).toEqual({ index: (index + 1) % 5, total: 5 });
      if (texts[index] === null) expect(highlightedSource(chat)).toMatchObject({ output: true, text: 'needle output' });
      else {
        const mark = chat.shadowRoot!.querySelector('.chat-search-mark')!;
        expect(mark.closest('code')?.textContent).toBe(texts[index]);
        expect(mark.closest('.edit-diff__header, .edit-diff__marker, .sr-only')).toBeNull();
      }
    }
  },
);

test.each(['history', 'live'])('counts an unchanged Edit context line once in split view in %s', async scope => {
  const input = {
    path: 'file.txt', old_string: 'needle context\nold line', new_string: 'needle context\nnew line',
  };
  const chat = scope === 'history' ? await toolHistory(input, 'Done', 'edit') : await liveTool('edit', input);
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const split = [...chat.shadowRoot!.querySelectorAll<HTMLButtonElement>('.edit-diff__mode-button')]
    .find(button => button.getAttribute('aria-label') === i18nService.t('coworkEditDiffSplitMode'))!;
  split.click();
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(chat.shadowRoot!.querySelectorAll('.chat-search-mark')).toHaveLength(1);
});

test('reveals live Edit search hits in a mounted Monaco diff or its visible fallback', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.mocked(window.requestAnimationFrame).mockImplementation(callback => frames.push(callback));
  const chat = await liveTool('edit', {
    path: 'file.ts', old_string: 'same context\nold source', new_string: 'same context\nnew source',
  });
  const root = chat.shadowRoot!;
  const host = root.querySelector<HTMLElement>('[data-edit-diff-monaco]')!;
  Object.defineProperty(host, 'getClientRects', { value: () => ({ length: 1 }) });
  frames.splice(0).forEach(frame => frame(0));
  await vi.waitFor(() => expect(host.classList.contains('is-ready')).toBe(true));

  chat.searchQuery = 'new source';
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(selectNativeEditRange).toHaveBeenCalledWith({
    startLineNumber: 2, endLineNumber: 2, startColumn: 1, endColumn: 11,
  });

  chat.searchQuery = 'old source';
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(host.querySelector('.edit-diff__monaco-fallback:not([aria-hidden]) .chat-search-mark')?.textContent)
    .toBe('old source');
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);
});

test.each(['history', 'live'])('finds Edit path and raw metadata without searching omitted diff code in %s', async scope => {
  const context = 'hidden-context\n'.repeat(20) + 'context\n'.repeat(5);
  const input = { id: 'openclaw:core:edit', args: {
    file_path: 'source/needle.ts', label: 'raw metadata only',
    edits: [{ oldText: `${context}needle old`, newText: `${context}new` }],
  } };
  const chat = scope === 'history' ? await toolHistory(input, 'Done', 'tool_call') : await liveTool('tool_call', input);
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  chat.getSearchMatchCount();
  const root = chat.shadowRoot!;
  await root.querySelector<ToolOutput>('[data-tool-search-source="raw-input"]')?.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(root.querySelector('[data-tool-search-source="edit-path"] .chat-search-mark')?.textContent).toBe('needle');
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(false);

  chat.searchQuery = 'raw metadata only';
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(root.querySelector('[data-tool-search-source="raw-input"] .chat-search-mark')?.textContent).toBe(chat.searchQuery);
  expect(root.querySelector<HTMLDetailsElement>('details[data-tool-identity]')?.open).toBe(true);

  chat.searchQuery = 'hidden-context';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(0);
});

test('manual reader paging unwraps a marked boundary before replacing plain source text', async () => {
  const query = 'needle-boundary';
  const output = `${'x'.repeat(15_995)}${query}${'y'.repeat(1_000)}`;
  const chat = await toolHistory({}, output, 'custom');
  chat.searchQuery = query;
  await chat.updateComplete;
  chat.navigateSearch(1);
  const mark = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  const reader = mark.closest<ToolOutput>('justdo-tool-output')!;
  const next = [...reader.querySelectorAll<HTMLButtonElement>('.message-reader-actions button')]
    .find(button => button.textContent?.trim() === i18nService.t('messageNext'))!;
  next.click();
  await reader.updateComplete;
  expect(reader.querySelector('.chat-search-mark')).toBeNull();
  expect(reader.querySelector('pre')!.textContent!.trimStart()).toBe(output.slice(16_000));
});

test('replacing marked plain reader source does not leave an old mark or suffix', async () => {
  const chat = await toolHistory({}, 'prefix needle suffix', 'custom');
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  chat.navigateSearch(1);
  const reader = chat.shadowRoot!.querySelector('.chat-search-mark')!.closest<ToolOutput>('justdo-tool-output')!;
  reader.text = 'replacement exact';
  await reader.updateComplete;
  expect(reader.querySelector('.chat-search-mark')).toBeNull();
  expect(reader.querySelector('pre')!.textContent!.trimStart()).toBe('replacement exact');
});
