// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageRenderer } from '../conversation-overlay/modules/sidepanel-messages.js';
import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';
import { BrowserExtensionStream } from '../conversation-overlay/modules/sidepanel-stream.js';
import { messagesFromThread } from '../conversation-overlay/modules/sidepanel-state.js';

const thinking = (id: string, status = 'completed') => ({
  key: `turn:thinking:${id}`,
  id,
  type: 'thinking',
  title: 'Thinking',
  text: `Thought ${id}`,
  status,
});
const tool = (id: string, status = 'completed', output = 'File contents') => ({
  key: `turn:tool:${id}`,
  id,
  type: 'tool',
  title: 'Read',
  input: '{ "path": "notes.txt" }',
  output,
  status,
});
const process = (key: string, items = [thinking(key), tool(key)]) => ({
  role: 'process',
  key,
  items,
});
const completed = (key: string, items: Array<Record<string, unknown>>) => ({
  role: 'completed-process',
  key,
  items,
});
const answer = (key: string, text: string) => ({ role: 'assistant', key, text });
const live = (item: Record<string, unknown>) => ({
  role: 'live-process',
  key: `live:${item.key}`,
  item,
});

describe('side panel process presentation matches the desktop', () => {
  let renderer: ReturnType<typeof createMessageRenderer>;
  let messages: HTMLElement;
  let latest: HTMLButtonElement;
  let processDetails: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML =
      '<main id="messages"></main><button id="latest" class="hidden">Latest</button><button id="processDetails" type="button"></button>';
    messages = document.getElementById('messages')!;
    latest = document.getElementById('latest') as HTMLButtonElement;
    processDetails = document.getElementById('processDetails') as HTMLButtonElement;
    renderer = createMessageRenderer(messages, {
      latestButton: latest,
      processDetailsButton: processDetails,
      readImage: vi.fn(),
    });
  });
  afterEach(() => renderer.dispose());

  const summary = (key: string) =>
    document.querySelector<HTMLElement>(`[data-process-summary-key="${key}"]`)!;
  const disclosure = (key: string) => summary(key).parentElement as HTMLDetailsElement;
  const history = () => messages.querySelector<HTMLDetailsElement>('.completed-process')!;

  it('renders question answers inside the existing disclosure and updates the same Lit host after timeout', () => {
    const questions = [{
      id: 'stack', question: 'Which stack?',
      options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }],
      defaultOptionIds: ['react'],
    }];
    const entry = (timedOut: boolean) => ({
      role: 'question-presentation', key: 'question',
      item: { type: 'tool', key: 'question-tool', status: 'completed', input: { questions },
        questionResult: { version: 1, questions, response: {
          status: 'answered', timedOut, answers: { stack: { selected: ['react'] } },
        } } },
    });
    renderer.render([completed('history', [entry(false)]), answer('final', 'Final answer')], 'question-session');
    const outer = history();
    expect(outer.open).toBe(false);
    outer.querySelector<HTMLElement>('summary')!.click();
    expect(outer.querySelector('.question-answer--human')?.textContent).toContain('Which stack?');
    expect(outer.querySelector('.question-answer--human')?.textContent).toContain('React');
    expect(messages.querySelector('.assistant')?.closest('.completed-process')).toBeNull();
    renderer.render([completed('history', [entry(true)]), answer('final', 'Final answer')], 'question-session');
    expect(history()).toBe(outer);
    expect(outer.querySelector('.question-answer--human')).toBeNull();
    expect(outer.querySelector('.question-answer--system')?.textContent).toContain('Which stack?');
    expect(outer.querySelector('.question-answer--system')?.textContent).toContain('React');
  });

  it('uses the desktop history trigger and lazy nested summaries, keeping the complete final answer outside', () => {
    const entries = [
      completed('history', [
        process('one'),
        answer('intermediate', 'Intermediate explanation'),
        process('two'),
      ]),
      answer('final', 'Final answer'),
    ];
    renderer.render(entries, 'one');
    const outer = history();
    expect(outer.open).toBe(false);
    expect(outer.firstElementChild?.getAttribute('aria-label')).toBe(t('expandProcessHistory'));
    expect(outer.firstElementChild?.textContent).not.toContain('×');
    expect(outer.querySelector('svg path')?.getAttribute('d')).toBe(
      'M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6M12 7v5l3 2',
    );
    expect(outer.querySelector('.process-summary-group')).toBeNull();
    expect(messages.querySelector('.assistant')?.textContent).toContain('Final answer');
    outer.querySelector<HTMLElement>('summary')!.click();
    expect(outer.firstElementChild?.getAttribute('aria-label')).toBe(t('collapseProcessHistory'));
    expect(outer.querySelectorAll('.process-summary-group')).toHaveLength(2);
    expect(outer.querySelector('.process-tool')).toBeNull();
    expect(outer.textContent).toContain('Intermediate explanation');
    expect(outer.textContent).not.toContain('Final answer');
    summary('one').click();
    expect(disclosure('one').open).toBe(true);
    expect(disclosure('one').querySelector('.message-detail')?.textContent).toContain(
      'Thought one',
    );
    summary('two').click();
    expect(disclosure('one').open).toBe(false);
    expect(disclosure('two').open).toBe(true);
    expect(outer.open).toBe(true);
  });

  it('keeps only one process summary open across independently expanded history groups', () => {
    renderer.render(
      [completed('history-one', [process('one')]), completed('history-two', [process('two')])],
      'one',
    );
    const outers = [...messages.querySelectorAll<HTMLDetailsElement>('.completed-process')];
    outers.forEach(outer => outer.querySelector<HTMLElement>('summary')!.click());
    summary('one').click();
    summary('two').click();
    expect(outers.map(outer => outer.open)).toEqual([true, true]);
    expect([disclosure('one').open, disclosure('two').open]).toEqual([false, true]);
    summary('two').click();
    expect(messages.querySelectorAll('.process-summary-group[open]')).toHaveLength(0);
  });

  it('shows live Thinking and Tool directly and preserves focused raw readers while their output grows', () => {
    const currentThinking = thinking('live', 'running');
    const currentTool = tool('live', 'inProgress', 'First result');
    renderer.render([live(currentThinking), live(currentTool)], 'one');
    expect(messages.querySelector('.process-summary-group')).toBeNull();
    expect(messages.querySelector('.completed-process')).toBeNull();
    expect(messages.querySelector('details.process-thinking')).toBeNull();
    expect(messages.querySelector('.message-detail')?.textContent).toContain('Thought live');
    const reader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    const title = reader.querySelector<HTMLElement>('summary')!;
    title.click();
    title.focus();
    const output = reader.querySelector<HTMLElement>('[data-section="output"] pre')!;
    output.scrollTop = 37;
    renderer.render(
      [
        live({ ...currentThinking, text: 'More thinking' }),
        live({ ...currentTool, output: 'Second result' }),
      ],
      'one',
    );
    expect(messages.querySelector('.process-tool')).toBe(reader);
    expect(reader.open).toBe(true);
    expect(document.activeElement).toBe(title);
    expect(output.scrollTop).toBe(37);
    expect(output.textContent).toBe('Second result');
  });

  it('retains the same raw Tool reader and choice when live content becomes a summary and later enters completed history', () => {
    const item = tool('same-source', 'inProgress');
    renderer.render([live(item)], 'one');
    const reader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    reader.querySelector<HTMLElement>('summary')!.click();
    const output = reader.querySelector<HTMLElement>('[data-section="output"] pre')!;
    output.scrollTop = 51;
    const settled = { ...item, status: 'completed' };
    const archived = process('summary', [settled]);
    renderer.render([archived], 'one');
    expect(disclosure('summary').open).toBe(false);
    summary('summary').click();
    expect(messages.querySelector('.process-tool')).toBe(reader);
    expect(reader.open).toBe(true);
    expect(output.scrollTop).toBe(51);
    renderer.render([completed('complete', [archived]), answer('final', 'Final')], 'one');
    history().querySelector<HTMLElement>('summary')!.click();
    expect(messages.querySelector('.process-tool')).toBe(reader);
    expect(disclosure('summary').open).toBe(true);
    expect(output.scrollTop).toBe(51);
  });

  it('renders native compaction details visibly and patches the same open reader when history enriches its summary', () => {
    const entry = {
      role: 'compaction',
      key: 'compact-native-entry',
      rawMessage: {
        role: 'system',
        content: '',
        __openclaw: {
          kind: 'compaction',
          id: 'compact-native-entry',
          tokensBefore: 12000,
          tokensAfter: 4000,
          summary: 'Preserved native decisions',
        },
      },
    };
    renderer.render([entry], 'one');
    const reader = messages.querySelector<HTMLDetailsElement>('.chat-divider__details')!;
    expect(reader).not.toBeNull();
    expect(reader.textContent).toContain('12,000 → 4,000 tokens');
    expect(reader.textContent).toContain('Preserved native decisions');
    reader.open = true;
    reader.querySelector<HTMLElement>('summary')!.focus();
    renderer.render(
      [
        {
          ...entry,
          rawMessage: {
            ...entry.rawMessage,
            __openclaw: {
              ...entry.rawMessage.__openclaw,
              summary: 'Preserved native decisions and constraints',
            },
          },
        },
      ],
      'one',
    );
    expect(messages.querySelector('.chat-divider__details')).toBe(reader);
    expect(reader.open).toBe(true);
    expect(document.activeElement).toBe(reader.querySelector('summary'));
    expect(reader.textContent).toContain('Preserved native decisions and constraints');
  });

  it('renders structured native progress receipts using the same visible plan counts and current step as the App', () => {
    const entry = {
      role: 'progress-receipt',
      key: 'progress-one',
      item: {
        id: 'progress-one',
        name: 'progress_card',
        status: 'completed',
        input: {
          plan: [
            { step: 'Inspect files', status: 'completed' },
            { step: 'Check results', status: 'in_progress' },
          ],
        },
      },
    };
    renderer.render([completed('history', [entry]), answer('final', 'Final')], 'one');
    expect(messages.querySelector('.progress-card-receipt')).toBeNull();
    history().querySelector<HTMLElement>('summary')!.click();
    const receipt = messages.querySelector('.progress-card-receipt')!;
    expect(receipt.textContent).toContain('1/2');
    expect(receipt.textContent).toContain('Check results');
    expect(receipt.textContent).not.toContain('[object Object]');
    expect(messages.querySelector('.process-tool')).toBeNull();
  });

  it('preserves an expanded and locally collapsed summary through real native source metadata takeover and settlement', () => {
    const stream = new BrowserExtensionStream('one');
    const initial = {
      id: 'one',
      turns: [
        {
          id: 'old-turn',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Earlier request' }] }],
        },
      ],
    };
    stream.setHistory(initial);
    stream.start('Current request');
    stream.bindRun('run-one');
    const emit = (seq: number, channel: string, data: Record<string, unknown>) =>
      stream.accept({
        kind: 'agent',
        event: {
          runId: 'run-one',
          sessionKey: 'agent:main:justdo:one',
          sessionId: null,
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          agentSeq: seq,
          frameSeq: seq,
          deliveryEvent: 'agent',
          timestamp: seq,
          stream: channel,
          data,
        },
      });
    emit(1, 'thinking', { text: 'Preserved native thought' });
    emit(2, 'assistant', { text: 'Native response' });
    renderer.render(messagesFromThread(stream.project()), 'one');
    const disclosure = messages.querySelector<HTMLDetailsElement>('.process-summary-group')!;
    const title = disclosure.querySelector<HTMLElement>('summary')!;
    title.click();
    title.focus();
    const nativeHistory = {
      id: 'one',
      turns: [
        ...initial.turns,
        {
          id: 'native-turn',
          items: [
            {
              id: 'native-user',
              type: 'userMessage',
              content: [{ type: 'text', text: 'Current request' }],
            },
            {
              id: 'native-thought',
              type: 'reasoning',
              content: ['Preserved native thought'],
              status: 'completed',
              display: {
                sourceId: 'native-source',
                sourceSegmentId: 'native-reasoning',
                sourceIndex: 1,
              },
            },
            {
              id: 'native-response',
              type: 'agentMessage',
              text: 'Native response',
              display: {
                sourceId: 'native-source',
                sourceSegmentId: 'native-answer',
                sourceIndex: 2,
              },
            },
          ],
        },
      ],
    };
    stream.setHistory(nativeHistory);
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(messages.querySelector('.process-summary-group')).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(title);
    processDetails.click();
    title.click();
    expect(disclosure.open).toBe(false);
    stream.setHistory(nativeHistory);
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(messages.querySelector('.process-summary-group')).toBe(disclosure);
    expect(disclosure.open).toBe(false);
    processDetails.click();
    processDetails.click();
    title.focus();
    stream.finish();
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(history().contains(disclosure)).toBe(true);
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(title);
    stream.setHistory(nativeHistory);
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(messages.querySelector('.process-summary-group')).toBe(disclosure);
    expect(document.activeElement).toBe(title);
  });

  it('bulk-controls completed history and summaries while live feedback and raw Tool choices remain independent', () => {
    const activeTool = tool('live', 'inProgress');
    const entries = [
      completed('history', [process('one'), process('two')]),
      live(thinking('live', 'running')),
      live(activeTool),
    ];
    const original = JSON.stringify(entries);
    renderer.render(entries, 'one');
    const currentReader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    currentReader.querySelector<HTMLElement>('summary')!.click();
    const title = currentReader.querySelector<HTMLElement>('summary')!;
    const output = currentReader.querySelector<HTMLElement>('[data-section="output"] pre')!;
    title.focus();
    output.scrollTop = 61;
    processDetails.click();
    expect(processDetails.getAttribute('aria-pressed')).toBe('true');
    expect(history().open).toBe(true);
    expect(messages.querySelectorAll('.process-summary-group[open]')).toHaveLength(2);
    expect(disclosure('one').querySelector<HTMLDetailsElement>('.process-tool')?.open).toBe(false);
    processDetails.click();
    expect(history().open).toBe(false);
    expect(messages.querySelectorAll('.process-summary-group[open]')).toHaveLength(0);
    expect(messages.querySelectorAll('.process-live')).toHaveLength(2);
    expect(currentReader.open).toBe(true);
    expect(messages.querySelector('.process-live-tool .process-tool')).toBe(currentReader);
    expect(document.activeElement).toBe(title);
    expect(output.scrollTop).toBe(61);
    expect(JSON.stringify(entries)).toBe(original);
  });

  it('allows per-summary exceptions in bulk mode and clears them on the next bulk operation', () => {
    renderer.render([completed('history', [process('one'), process('two')])], 'one');
    processDetails.click();
    summary('one').click();
    expect([disclosure('one').open, disclosure('two').open]).toEqual([false, true]);
    renderer.render(currentEntries(), 'one');
    expect(disclosure('one').open).toBe(false);
    processDetails.click();
    processDetails.click();
    expect([disclosure('one').open, disclosure('two').open]).toEqual([true, true]);
    history().querySelector<HTMLElement>('summary')!.click();
    processDetails.click();
    processDetails.click();
    expect(history().open).toBe(true);
    function currentEntries() {
      return [completed('history', [process('one'), process('two')])];
    }
  });

  it('applies bulk mode to newly arriving groups without overriding an individual exception', () => {
    const entries = [process('one')];
    renderer.render(entries, 'one');
    processDetails.click();
    summary('one').click();
    renderer.render([...entries, completed('later', [process('two')])], 'one');
    expect(disclosure('one').open).toBe(false);
    expect(history().open).toBe(true);
    expect(disclosure('two').open).toBe(true);
  });

  it('resets bulk mode on conversation changes but restores scoped individual history, summary and raw Tool choices', () => {
    const entries = [completed('history', [process('one'), process('two')])];
    renderer.render(entries, 'one');
    history().querySelector<HTMLElement>('summary')!.click();
    summary('one').click();
    messages
      .querySelector<HTMLDetailsElement>('.process-tool')!
      .querySelector<HTMLElement>('summary')!
      .click();
    renderer.render(entries, 'two');
    expect(processDetails.getAttribute('aria-pressed')).toBe('false');
    expect(history().open).toBe(false);
    renderer.render(entries, 'one');
    expect(history().open).toBe(true);
    expect(disclosure('one').open).toBe(true);
    expect(disclosure('two').open).toBe(false);
    expect(messages.querySelector<HTMLDetailsElement>('.process-tool')?.open).toBe(true);
    processDetails.click();
    renderer.render(entries, 'two');
    expect(processDetails.getAttribute('aria-pressed')).toBe('false');
  });

  it('closes the default accordion with Escape and restores summary focus without changing raw Tool choice', () => {
    renderer.render([process('one')], 'one');
    summary('one').click();
    const reader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    reader.querySelector<HTMLElement>('summary')!.click();
    messages.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(disclosure('one').open).toBe(false);
    expect(document.activeElement).toBe(summary('one'));
    expect(reader.open).toBe(true);
  });

  it('pauses following immediately on upward input and only resumes through returning to latest', () => {
    let scrollHeight = 1000;
    Object.defineProperties(messages, {
      scrollHeight: { get: () => scrollHeight },
      clientHeight: { value: 200 },
    });
    renderer.render([answer('body', 'First response')], 'one');
    messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 }));
    messages.dispatchEvent(new Event('scroll'));
    messages.scrollTop = 650;
    scrollHeight = 1400;
    renderer.render([answer('body', 'Longer response')], 'one');
    expect(messages.scrollTop).toBe(650);
    expect(latest.classList.contains('hidden')).toBe(false);
    latest.click();
    expect(messages.scrollTop).toBe(1400);
    expect(latest.classList.contains('hidden')).toBe(true);
  });

  it('preserves the clicked summary anchor when accordion collapse removes preceding height', () => {
    renderer.render([process('one'), process('two')], 'one');
    summary('one').click();
    messages.scrollTop = 400;
    summary('two').getBoundingClientRect = () =>
      ({ top: disclosure('one').open ? 200 : 80 }) as DOMRect;
    summary('two').click();
    expect(messages.scrollTop).toBe(280);
    expect(disclosure('two').open).toBe(true);
  });

  it('ignores queued toggle events from a detached previous conversation', () => {
    renderer.render([process('one')], 'one');
    const previous = disclosure('one');
    renderer.render([process('one')], 'two');
    previous.open = true;
    previous.dispatchEvent(new Event('toggle'));
    expect(disclosure('one').open).toBe(false);
    expect(messages.querySelector('.process-tool')).toBeNull();
  });

  it.each([
    ['en-US', 'Expand all process details', 'Collapse all process details'],
    ['zh-CN', '展开所有过程详情', '折叠所有过程详情'],
  ])('localizes bulk accessibility state for %s', async (language, expand, collapse) => {
    const languageGetter = vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
    vi.resetModules();
    const { createMessageRenderer: createLocalizedRenderer } =
      await import('../conversation-overlay/modules/sidepanel-messages.js');
    const host = document.createElement('main');
    const button = document.createElement('button');
    const localized = createLocalizedRenderer(host, {
      readImage: vi.fn(),
      latestButton: document.createElement('button'),
      processDetailsButton: button,
    });
    try {
      localized.render([process('one')], language);
      expect(button.title).toBe(expand);
      expect(button.getAttribute('aria-label')).toBe(expand);
      expect(button.getAttribute('aria-pressed')).toBe('false');
      button.click();
      expect(button.title).toBe(collapse);
      expect(button.getAttribute('aria-label')).toBe(collapse);
      expect(button.getAttribute('aria-pressed')).toBe('true');
    } finally {
      localized.dispose();
      languageGetter.mockRestore();
      vi.resetModules();
    }
  });
});
