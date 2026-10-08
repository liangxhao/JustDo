// @vitest-environment jsdom
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  notify: (_method: string, _params: unknown) => {},
  request: vi.fn(),
}));
vi.mock(
  '../../resources/browser-extension/conversation-overlay/modules/conversation-client.js',
  () => ({
    AppServerClient: class {
      constructor(notify: typeof mock.notify) {
        mock.notify = notify;
      }
      request = mock.request;
      disconnect() {}
    },
  }),
);

describe('extension streaming DOM', () => {
  beforeEach(() => {
    vi.resetModules();
    mock.request.mockReset();
  });

  async function mountThread() {
    document.documentElement.innerHTML = fs.readFileSync(
      'resources/browser-extension/conversation-overlay/sidepanel.html',
      'utf8',
    );
    const thread = {
      id: 'one',
      turns: [
        {
          id: 'history-1',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Question' }] }],
        },
      ],
    };
    const respond = async (method: string) => {
      if (method === 'thread/list') return { data: [{ id: 'one', status: { type: 'idle' } }] };
      if (method === 'thread/read') return { thread };
      if (method === 'composer/options')
        return { models: [{ id: 'p/m', name: 'Model' }], modelRef: 'p/m', permissionMode: 'ask' };
      return {};
    };
    mock.request.mockImplementation(respond);
    await import('../../resources/browser-extension/conversation-overlay/sidepanel.js');
    const select = document.getElementById('session') as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(2));
    select.value = 'one';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.querySelector('.message.user')?.textContent).toContain('Question'),
    );
    const emit = (seq: number, stream: string, data: Record<string, unknown>, threadId = 'one') =>
      mock.notify('thread/stream', {
        threadId,
        kind: 'agent',
        event: {
          runId: 'run-1',
          sessionKey: 'agent:main:justdo:one',
          sessionId: null,
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          agentSeq: seq,
          frameSeq: seq,
          deliveryEvent: 'agent',
          timestamp: seq,
          stream,
          data,
        },
      });
    return { thread, respond, emit };
  }

  it('opens live thinking, respects manual collapse, and collapses completed thinking', async () => {
    const { emit } = await mountThread();
    emit(1, 'thinking', { text: 'Considering' });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDetailsElement>('.process-cluster')?.open).toBe(true),
    );
    document.querySelector<HTMLElement>('.process-cluster > summary')!.click();
    emit(2, 'thinking', { text: 'Considering more' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent).toBe('Considering more'),
    );
    expect(document.querySelector<HTMLDetailsElement>('.process-cluster')?.open).toBe(false);
    document.querySelector<HTMLElement>('.process-cluster > summary')!.click();
    emit(3, 'assistant', { text: 'Answer' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent?.trim()).toBe('Answer'),
    );
    expect(document.querySelector<HTMLDetailsElement>('.process-cluster')?.open).toBe(true);
  });

  it('automatically collapses thinking when content starts without a manual preference', async () => {
    const { emit } = await mountThread();
    emit(1, 'thinking', { text: 'Considering' });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDetailsElement>('.process-cluster')?.open).toBe(true),
    );
    emit(2, 'assistant', { text: 'Answer' });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDetailsElement>('.process-cluster')?.open).toBe(false),
    );
  });

  it('keeps historical thinking collapsed and uses matching header icon geometry', async () => {
    const { thread } = await mountThread();
    mock.notify('thread/updated', {
      threadId: 'one',
      thread: {
        ...thread,
        turns: [{ id: 'history-1', items: [{ type: 'reasoning', content: ['Past thought'] }] }],
      },
    });
    expect(document.querySelector<HTMLDetailsElement>('.process-cluster')?.open).toBe(false);
    for (const id of ['refresh', 'settings']) {
      expect(document.getElementById(id)?.className).toBe('icon');
      expect(document.querySelector(`#${id} svg`)?.getAttribute('viewBox')).toBe('0 0 24 24');
    }
  });

  it('keeps the current subscription and final history when same-thread refreshes race', async () => {
    const { thread, respond, emit } = await mountThread();
    emit(1, 'assistant', { text: 'Partial text' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Partial'),
    );
    const reads: Array<(value: unknown) => void> = [];
    mock.request.mockImplementation((method: string) =>
      method === 'thread/read' ? new Promise(resolve => reads.push(resolve)) : respond(method),
    );
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', status: 'completed', error: null },
    });
    await vi.waitFor(() => expect(reads.length).toBe(1));
    document.getElementById('refresh')!.click();
    await vi.waitFor(() => expect(reads.length).toBe(2));
    reads[1]({
      thread: {
        ...thread,
        turns: [
          {
            id: 'history-1',
            items: [
              ...thread.turns[0].items,
              { type: 'agentMessage', text: 'Authoritative final reply' },
            ],
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Authoritative'),
    );
    expect(document.querySelectorAll('.assistant')).toHaveLength(1);
    reads[0]({ thread });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mock.request).not.toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'one' });
    expect(document.querySelector('.assistant')?.textContent).toContain('Authoritative');
  });

  it('retains partial text after stop even when its completion refresh is superseded', async () => {
    const { thread, respond, emit } = await mountThread();
    emit(1, 'tool', { phase: 'start', toolCallId: 't1', name: 'read', args: { path: 'a' } });
    emit(2, 'assistant', { text: 'Partial reply' });
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1' } });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Partial'),
    );
    const reads: Array<(value: unknown) => void> = [];
    mock.request.mockImplementation((method: string) => {
      if (method === 'thread/read') return new Promise(resolve => reads.push(resolve));
      if (method === 'turn/interrupt') {
        mock.notify('turn/completed', {
          threadId: 'one',
          turn: { id: 'run-1', status: 'interrupted', error: null },
        });
        return Promise.resolve({});
      }
      return respond(method);
    });
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(1));
    // The RPC response can supersede its preceding completion notification's refresh.
    for (const resolve of reads) resolve({ thread });
    await vi.waitFor(() =>
      expect(
        document.querySelector('.process-tool-status')?.classList.contains('interrupted'),
      ).toBe(true),
    );
    expect(document.querySelector('.assistant')?.textContent).toContain('Partial reply');
    expect(mock.request).not.toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'one' });
  });

  it('does not discard live output when final history refresh fails', async () => {
    const { thread, respond, emit } = await mountThread();
    emit(1, 'assistant', { text: 'Complete streamed reply' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Complete'),
    );
    mock.request.mockImplementation((method: string) =>
      method === 'thread/read' ? Promise.reject(new Error('History unavailable')) : respond(method),
    );
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', status: 'completed', error: null },
    });
    await vi.waitFor(() =>
      expect(document.getElementById('error')?.textContent).toContain('History unavailable'),
    );
    expect(document.querySelector('.assistant')?.textContent).toContain('Complete streamed reply');
    mock.request.mockImplementation((method: string) =>
      method === 'thread/read'
        ? Promise.resolve({
            thread: {
              ...thread,
              turns: [
                {
                  id: 'history-1',
                  items: [
                    ...thread.turns[0].items,
                    { type: 'agentMessage', text: 'Persisted final reply' },
                  ],
                },
              ],
            },
          })
        : respond(method),
    );
    document.getElementById('refresh')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Persisted'),
    );
    expect(document.querySelectorAll('.assistant')).toHaveLength(1);
  });

  it.each([
    { text: '你好啊', count: 1 },
    { text: 'Question', count: 2 },
  ])(
    'preserves $count bubble(s) for "$text" through acceptance, failed refresh, and final history',
    async ({ text, count }) => {
      const { thread, respond, emit } = await mountThread();
      mock.request.mockImplementation((method: string) => {
        if (method === 'turn/start') return Promise.resolve({ turn: { id: 'run-1' } });
        if (method === 'thread/read') return Promise.reject(new Error('History unavailable'));
        return respond(method);
      });
      const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
      (document.getElementById('includePage') as HTMLInputElement).checked = false;
      prompt.value = text;
      prompt.dispatchEvent(new Event('input'));
      document.getElementById('send')!.click();
      await vi.waitFor(() =>
        expect(document.getElementById('error')?.textContent).toContain('History unavailable'),
      );
      emit(1, 'thinking', { text: 'Considering' });
      await vi.waitFor(() => expect(document.querySelector('.process-cluster')).not.toBeNull());
      const submitted = () =>
        [...document.querySelectorAll('.message.user')].filter(
          node => node.textContent?.trim() === text,
        );
      expect(submitted()).toHaveLength(count);
      emit(2, 'assistant', { text: 'Hello back' });
      await vi.waitFor(() =>
        expect(document.querySelector('.assistant')?.textContent).toContain('Hello back'),
      );
      mock.notify('thread/updated', {
        threadId: 'one',
        thread: {
          ...thread,
          turns: [
            ...thread.turns,
            {
              id: 'history-2',
              items: [
                { type: 'userMessage', content: [{ type: 'text', text }] },
                { type: 'reasoning', content: ['Considering'] },
                { type: 'agentMessage', text: 'Hello back' },
              ],
            },
          ],
        },
      });
      expect(submitted()).toHaveLength(count);
      expect(
        document.querySelector('#messages > :last-child')?.classList.contains('assistant'),
      ).toBe(true);
      expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    },
  );

  it('hands the new-chat bubble to the stream before acceptance', async () => {
    const { respond, emit } = await mountThread();
    const select = document.getElementById('session') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    prompt.value = 'Question';
    prompt.dispatchEvent(new Event('input'));
    const send = document.getElementById('send') as HTMLButtonElement;
    await vi.waitFor(() => expect(send.disabled).toBe(false));
    let resolveThread!: (value: unknown) => void;
    let resolveTurn!: (value: unknown) => void;
    mock.request.mockImplementation((method: string) => {
      if (method === 'thread/start')
        return new Promise(resolve => {
          resolveThread = resolve;
        });
      if (method === 'turn/start')
        return new Promise(resolve => {
          resolveTurn = resolve;
        });
      if (method === 'thread/list')
        return Promise.resolve({
          data: [
            { id: 'one', status: { type: 'idle' } },
            { id: 'two', status: { type: 'active' } },
          ],
        });
      if (method === 'thread/read') return Promise.resolve({ thread: { id: 'two', turns: [] } });
      return respond(method);
    });
    send.click();
    await vi.waitFor(() => expect(resolveThread).toBeDefined());
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
    resolveThread({ thread: { id: 'two' } });
    await vi.waitFor(() => expect(resolveTurn).toBeDefined());
    // A native stream can arrive before the turn/start acknowledgement.
    emit(1, 'thinking', { text: 'Considering' }, 'two');
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
    resolveTurn({ turn: { id: 'run-1' } });
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
    expect(document.querySelector('.process-cluster')).not.toBeNull();
    mock.notify('thread/updated', {
      threadId: 'two',
      thread: {
        id: 'two',
        turns: [
          {
            id: 'history-1',
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
              { type: 'agentMessage', text: 'Second answer' },
            ],
          },
        ],
      },
    });
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });
  it('renders partial Markdown and preserves open process details across streaming updates and final history', async () => {
    document.documentElement.innerHTML = fs.readFileSync(
      'resources/browser-extension/conversation-overlay/sidepanel.html',
      'utf8',
    );
    const thread = {
      id: 'one',
      title: 'One',
      turns: [
        {
          id: 'history-1',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Question' }] }],
        },
      ],
    };
    mock.request.mockImplementation(async (method: string) => {
      if (method === 'thread/list')
        return { data: [{ id: 'one', title: 'One', status: { type: 'idle' } }] };
      if (method === 'thread/read') return { thread };
      if (method === 'composer/options')
        return { models: [{ id: 'p/m', name: 'Model' }], modelRef: 'p/m', permissionMode: 'ask' };
      return {};
    });
    await import('../../resources/browser-extension/conversation-overlay/sidepanel.js');
    const select = document.getElementById('session') as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(2));
    select.value = 'one';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.querySelector('.message.user')?.textContent).toContain('Question'),
    );
    const send = (seq: number, stream: string, data: Record<string, unknown>) =>
      mock.notify('thread/stream', {
        threadId: 'one',
        kind: 'agent',
        event: {
          runId: 'run-1',
          sessionKey: 'agent:main:justdo:one',
          sessionId: null,
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          agentSeq: seq,
          frameSeq: seq,
          deliveryEvent: 'agent',
          timestamp: seq,
          stream,
          data,
        },
      });
    send(1, 'thinking', { thinking: 'Inspect' });
    await vi.waitFor(() => expect(document.querySelector('.process-cluster')).not.toBeNull());
    // Explicitly close and reopen to pin the live group's expansion.
    document.querySelector<HTMLElement>('.process-cluster > summary')!.click();
    document.querySelector<HTMLElement>('.process-cluster > summary')!.click();
    send(2, 'thinking', { thinking: 'Inspect the file' });
    send(3, 'tool', { phase: 'start', name: 'read', toolCallId: 't1', args: { path: 'a.txt' } });
    await vi.waitFor(() => expect(document.querySelector('.process-tool')).not.toBeNull());
    expect((document.querySelector('.process-cluster') as HTMLDetailsElement).open).toBe(true);
    (document.querySelector('.process-tool') as HTMLDetailsElement).open = true;
    send(4, 'tool', { phase: 'result', name: 'read', toolCallId: 't1', result: 'File content' });
    send(5, 'assistant', { text: '**Hello**' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant strong')?.textContent).toBe('Hello'),
    );
    const userNode = document.querySelector('.message.user');
    const processNode = document.querySelector('.process-cluster');
    send(6, 'assistant', { text: '**Hello** world' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('world'),
    );
    expect(document.querySelector('.message.user')).toBe(userNode);
    expect(document.querySelector('.process-cluster')).toBe(processNode);
    expect((document.querySelector('.process-tool') as HTMLDetailsElement).open).toBe(true);
    // A lagging history update must not remove live text or rebuild old bubbles.
    mock.notify('thread/updated', { threadId: 'one', thread });
    expect(document.querySelector('.assistant')?.textContent).toContain('world');
    expect(document.querySelectorAll('.assistant')).toHaveLength(1);
    Object.assign(thread.turns[0], {
      items: [
        ...thread.turns[0].items,
        { id: 'history-thinking', type: 'reasoning', content: ['Inspect the file'] },
        {
          id: 'history-tool',
          type: 'toolCall',
          toolUseId: 't1',
          toolName: 'read',
          input: { path: 'a.txt' },
          output: 'File content',
          status: 'completed',
        },
        { id: 'history-text', type: 'agentMessage', text: '**Hello** world!' },
      ],
    });
    mock.notify('turn/completed', { threadId: 'one', turn: { id: 'run-1', error: null } });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('world!'),
    );
    expect((document.querySelector('.process-cluster') as HTMLDetailsElement).open).toBe(true);
    expect((document.querySelector('.process-tool') as HTMLDetailsElement).open).toBe(true);
  });
});
