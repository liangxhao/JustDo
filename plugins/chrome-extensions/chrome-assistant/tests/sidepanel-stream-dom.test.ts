// @vitest-environment jsdom
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';

const mock = vi.hoisted(() => ({
  notify: (_method: string, _params: unknown) => {},
  request: vi.fn(),
  requestHandler: (_request: unknown, _options?: unknown) => Promise.resolve({ decision: 'decline' }),
}));

// The scenarios below keep their rich display fixtures separate from canonical
// protocol history. Native identities appear only in the browser enhancement.
function protocolResult(method: string, result: Record<string, unknown>) {
  if (method === 'model/list' && !Array.isArray(result.data))
    return { data: [{ id: 'p/m', displayName: 'Model' }], nextCursor: null };
  const thread = result.thread as { id: string; turns: unknown[]; status?: unknown; chrome?: unknown } | undefined;
  if (method === 'thread/resume' && thread && !thread.chrome) {
    const { activeTurn, ...rest } = result;
    return { ...rest, thread: { id: thread.id, status: thread.status, turns: [],
      chrome: { display: { id: thread.id, turns: thread.turns }, activeTurn: activeTurn ?? null } } };
  }
  const turn = result.turn as Record<string, unknown> | undefined;
  if (method === 'turn/start' && turn?.nativeRunId) {
    const { nativeRunId, ...core } = turn;
    return { ...result, turn: { ...core, status: 'inProgress' },
      chrome: { activeTurn: { id: turn.id, nativeRunId, status: 'inProgress', executionSettled: false } } };
  }
  return result;
}

vi.mock('../conversation-overlay/modules/conversation-client.js', () => ({
  AppServerClient: class {
    constructor(notify: typeof mock.notify, options: { requestHandler: typeof mock.requestHandler }) {
      mock.requestHandler = options.requestHandler;
      mock.notify = (method: string, value: unknown) => {
        const params = value as Record<string, unknown>;
        if (method === 'chrome/thread/updated' && params.thread) {
          const { thread, ...rest } = params;
          notify(method, { ...rest, display: thread });
          return;
        }
        const turn = params?.turn as Record<string, unknown> | undefined;
        if (method === 'turn/started' && turn?.nativeRunId) {
          const { nativeRunId, ...core } = turn;
          notify(method, { ...params, turn: { ...core, status: 'inProgress' } });
          notify('chrome/thread/updated', { threadId: params.threadId,
            activeTurn: { id: turn.id, nativeRunId, status: 'inProgress', executionSettled: false } });
          return;
        }
        if (method === 'turn/completed' && turn?.executionSettled === true && !turn.status) {
          notify(method, { ...params, turn: { ...turn, status: 'completed' } });
          return;
        }
        notify(method, params);
      };
    }
    request = async (method: string, params?: Record<string, unknown>) =>
      protocolResult(method, await mock.request(method, params));
    disconnect() {}
  },
}));

describe('extension streaming DOM', () => {
  beforeEach(() => {
    vi.resetModules();
    mock.request.mockReset();
  });
  afterEach(() => window.dispatchEvent(new Event('unload')));

  async function mountThread() {
    document.documentElement.innerHTML = fs.readFileSync(
      'plugins/chrome-extensions/chrome-assistant/conversation-overlay/sidepanel.html',
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
      if (method === 'thread/resume') return { thread };
      if (method === 'chrome/composer/options')
        return { models: [{ id: 'p/m', name: 'Model' }], modelRef: 'p/m', permissionMode: 'ask' };
      return {};
    };
    mock.request.mockImplementation(respond);
    await import('../conversation-overlay/sidepanel.js');
    const select = document.getElementById('session') as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(2));
    select.value = 'one';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.querySelector('.message.user')?.textContent).toContain('Question'),
    );
    const emit = (
      seq: number,
      stream: string,
      data: Record<string, unknown>,
      threadId = 'one',
      runId = 'run-1',
    ) =>
      mock.notify('chrome/thread/stream', {
        threadId,
        kind: 'agent',
        event: {
          runId,
          sessionKey: `agent:main:justdo:${threadId}`,
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

  it('waits for cold host preparation before reading the real model catalog and enables the draft without sending', async () => {
    document.documentElement.innerHTML = fs.readFileSync(
      'plugins/chrome-extensions/chrome-assistant/conversation-overlay/sidepanel.html', 'utf8',
    );
    let finishPreparation!: (value: Record<string, unknown>) => void;
    const preparing = new Promise<Record<string, unknown>>(resolve => { finishPreparation = resolve; });
    let runtimeReady = false;
    mock.request.mockImplementation(async (method: string) => {
      if (method === 'thread/list') return { data: [] };
      if (method === 'chrome/composer/options') return preparing;
      if (method === 'model/list') {
        if (!runtimeReady) throw new Error('Gateway is unavailable for model reads.');
        return { data: [{ id: 'p/m', displayName: 'Live model catalog' }], nextCursor: null };
      }
      return {};
    });
    await import('../conversation-overlay/sidepanel.js');
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('chrome/composer/options', {}));
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'Keep this draft';
    prompt.dispatchEvent(new Event('input'));
    expect(mock.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(0);
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);

    runtimeReady = true;
    finishPreparation({ modelRef: 'p/m', permissionMode: 'ask', models: [{ id: 'stored-only', name: 'Stored fallback' }] });

    await vi.waitFor(() => expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false));
    expect(document.getElementById('model')?.textContent).toContain('Live model catalog');
    expect(document.getElementById('model')?.textContent).not.toContain('Stored fallback');
    expect(document.getElementById('error')?.textContent).toBe('');
    expect(prompt.value).toBe('Keep this draft');
    expect(mock.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1);
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
  });

  it('shows exact pre-response approvals and withdraws them when switching without stopping or changing a draft', async () => {
    const { respond } = await mountThread();
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'logical-turn', status: 'inProgress' } });
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'Keep this draft';
    const result = mock.requestHandler({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'one', turnId: 'logical-turn', itemId: 'exec', command: 'Read-only check', cwd: '/task', reason: 'User task',
    } }, { signal: new AbortController().signal });
    expect(document.getElementById('approvals')?.textContent).toContain('Read-only check');
    const staleAllow = document.querySelector<HTMLButtonElement>('[data-decision="accept"]')!;
    const select = document.getElementById('session') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    staleAllow.click();
    await expect(result).resolves.toEqual({ decision: 'decline' });
    await vi.waitFor(() => expect(document.getElementById('approvals')?.classList.contains('hidden')).toBe(true));
    expect(prompt.value).toBe('Keep this draft');
    expect(mock.request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false);
    mock.request.mockImplementation(respond);
  });

  it('permits a fresh conversation approval before the original turn response without replaying its input', async () => {
    const { respond } = await mountThread();
    const select = document.getElementById('session') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    let finishStart!: (value: Record<string, unknown>) => void;
    const pendingStart = new Promise<Record<string, unknown>>(resolve => { finishStart = resolve; });
    let submitted: Record<string, unknown>;
    mock.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return { thread: { id: 'new-thread', name: 'New task' } };
      if (method === 'turn/start') { submitted = params; return pendingStart; }
      if (method === 'thread/list') return { data: [{ id: 'one' }, { id: 'new-thread' }] };
      if (method === 'thread/resume' && params.threadId === 'new-thread')
        return { thread: { id: 'new-thread', turns: [], chrome: { display: { id: 'new-thread', turns: [] }, activeTurn: null } } };
      return respond(method);
    });
    await vi.waitFor(() => expect((document.getElementById('model') as HTMLSelectElement).disabled).toBe(false));
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'New task';
    prompt.dispatchEvent(new Event('input'));
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(submitted).toBeDefined());
    const turnId = (submitted!.chrome as { clientTurnId: string }).clientTurnId;
    expect(select.value).toBe('new-thread');
    const result = mock.requestHandler({ id: 'pre-response', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'new-thread', turnId, itemId: 'exec', command: 'Check current files',
    } }, { signal: new AbortController().signal });
    document.querySelector<HTMLButtonElement>('[data-decision="accept"]')!.click();
    await expect(result).resolves.toEqual({ decision: 'accept' });
    finishStart({ turn: { id: turnId, status: 'inProgress' } });
    await vi.waitFor(() => expect((document.getElementById('session') as HTMLSelectElement).disabled).toBe(false));
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });

  it('withdraws an approval immediately on Stop without treating its acknowledgement as a terminal', async () => {
    await mountThread();
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'logical-turn', status: 'inProgress' } });
    const pending = mock.requestHandler({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'one', turnId: 'logical-turn', itemId: 'exec', command: 'Pending command',
    } }, { signal: new AbortController().signal });
    document.getElementById('send')!.click();
    await expect(pending).resolves.toEqual({ decision: 'decline' });
    expect(document.getElementById('approvals')?.classList.contains('hidden')).toBe(true);
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'one', turnId: 'logical-turn',
    }));
    expect(document.getElementById('send')?.getAttribute('aria-label')).toBe('Stop');
    const late = mock.requestHandler({ id: 'late', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'one', turnId: 'logical-turn', itemId: 'later-exec', command: 'Late command',
    } }, { signal: new AbortController().signal });
    await expect(late).resolves.toEqual({ decision: 'decline' });
  });

  it('keeps focus in a pre-response secret answer when turn admission finishes', async () => {
    const { respond } = await mountThread();
    let finishStart!: (value: Record<string, unknown>) => void;
    let submitted: Record<string, unknown> | undefined;
    mock.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'turn/start') {
        submitted = params;
        return new Promise(resolve => { finishStart = resolve; });
      }
      return respond(method);
    });
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'Start task';
    prompt.dispatchEvent(new Event('input'));
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(submitted).toBeDefined());
    const turnId = (submitted!.chrome as { clientTurnId: string }).clientTurnId;
    const pending = mock.requestHandler({ id: 'private', method: 'item/tool/requestUserInput', params: {
      threadId: 'one', turnId, itemId: 'input', isBlocking: true,
      questions: [{ id: 'value', header: 'Private answer', question: 'Enter value', isSecret: true, options: null }],
    } }, { signal: new AbortController().signal });
    const secret = document.querySelector<HTMLInputElement>('#approvals input[type="password"]')!;
    secret.value = 'private-value';
    secret.dispatchEvent(new Event('input'));
    secret.focus();
    finishStart({ turn: { id: turnId, status: 'inProgress' } });
    await vi.waitFor(() => expect((document.getElementById('session') as HTMLSelectElement).disabled).toBe(false));
    expect(document.activeElement).toBe(secret);
    expect(prompt.value).toBe('');
    document.querySelector<HTMLButtonElement>('#approvals button[type="submit"]')!.click();
    await expect(pending).resolves.toEqual({ answers: { value: { answers: ['private-value'] } } });
    expect(secret.value).toBe('');
    expect(prompt.value).toBe('');
  });

  it('loads the standard model catalog and renders only the optional rich lane once', async () => {
    const { thread, respond, emit } = await mountThread();
    mock.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'model/list') return params.cursor
        ? { data: [{ id: 'p/second', displayName: 'Second catalog model' }], nextCursor: null }
        : { data: [{ id: 'p/m', displayName: 'Canonical catalog model' }], nextCursor: 'next-models' };
      if (method === 'chrome/composer/options')
        return { modelRef: 'p/m', permissionMode: 'ask', models: [{ id: 'ignored', name: 'Old composer catalog' }] };
      if (method === 'thread/resume') return { thread: {
        id: 'one', status: { type: 'idle' },
        turns: [{ id: 'canonical-run', status: 'failed', items: [{ type: 'agentMessage', text: 'Core history is not another rich display lane.' }] }],
        chrome: { display: thread, activeTurn: null },
      } };
      return respond(method);
    });
    document.getElementById('refresh')!.click();
    await vi.waitFor(() => expect((document.getElementById('model') as HTMLSelectElement).options.length).toBe(2));
    expect(document.getElementById('model')?.textContent).toContain('Canonical catalog model');
    expect(document.getElementById('model')?.textContent).not.toContain('Old composer catalog');
    expect(mock.request).toHaveBeenCalledWith('model/list', { limit: 200, cursor: 'next-models' });
    expect(document.getElementById('messages')?.textContent).not.toContain('Core history is not another');
    mock.notify('chrome/thread/updated', { threadId: 'one', display: { id: 'other', turns: [{ id: 'foreign', items: [{ type: 'agentMessage', text: 'Different conversation' }] }] } });
    expect(document.getElementById('messages')?.textContent).not.toContain('Different conversation');

    emit(1, 'assistant', { text: 'Only one visible answer' });
    mock.notify('item/started', { threadId: 'one', turnId: 'run-1', item: { id: 'core-item', type: 'agentMessage', text: '' } });
    mock.notify('item/agentMessage/delta', { threadId: 'one', turnId: 'run-1', itemId: 'core-item', delta: 'Only one visible answer' });
    await vi.waitFor(() => expect(document.querySelectorAll('.message.assistant')).toHaveLength(1));
    expect(document.querySelector('.message.assistant')?.textContent?.match(/Only one visible answer/g)).toHaveLength(1);
  });

  it('sends standard input and model with explicitly namespaced browser options', async () => {
    const { respond } = await mountThread();
    let submitted: Record<string, unknown> | undefined;
    mock.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'turn/start') {
        submitted = params;
        const id = (params.chrome as { clientTurnId: string }).clientTurnId;
        return { turn: { id, status: 'inProgress' }, chrome: { activeTurn: { id, nativeRunId: 'exact-native', status: 'inProgress', executionSettled: false } } };
      }
      return respond(method);
    });
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'One explicit input';
    prompt.dispatchEvent(new Event('input'));
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({ threadId: 'one', model: 'p/m', input: [{ type: 'text', text: 'One explicit input' }], chrome: { clientTurnId: expect.any(String), permissionMode: 'ask' } });
    for (const key of ['clientTurnId', 'modelRef', 'permissionMode', 'attachments', 'pageContext'])
      expect(submitted).not.toHaveProperty(key);
    expect(mock.request.mock.calls.some(([method]) => method === 'thread/read')).toBe(false);
    expect(mock.request).toHaveBeenCalledWith('thread/resume', { threadId: 'one', excludeTurns: true, chrome: { includeDisplay: true } });
  });

  it('sends image-only standard input with document extensions and keeps attachments after a proven unsent failure', async () => {
    const { respond } = await mountThread();
    mock.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'turn/start') throw Object.assign(new Error('Not sent'), { requestSent: false });
      return respond(method, params);
    });
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const input = document.getElementById('fileInput') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [
      { name: 'picture.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer },
      { name: 'notes.txt', type: 'text/plain', size: 1, arrayBuffer: async () => new Uint8Array([65]).buffer },
    ] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelectorAll('.attachment-chip')).toHaveLength(2));
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    expect(prompt.value).toBe('');
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false);
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(document.getElementById('error')?.textContent).toBe('Not sent'));
    const submitted = mock.request.mock.calls.find(([method]) => method === 'turn/start')![1];
    expect(submitted.input).toEqual([{ type: 'image', url: 'data:image/png;base64,AQIDBA==' }]);
    expect(submitted.chrome.attachments).toEqual([{ name: 'notes.txt', mimeType: 'text/plain', base64Data: 'QQ==' }]);
    expect(prompt.value).toBe('');
    expect(document.querySelectorAll('.attachment-chip')).toHaveLength(2);
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });

  it('waits for native tool start before displaying streamed argument previews as a tool', async () => {
    const { emit } = await mountThread();
    emit(1, 'thinking', { text: 'Preparing the tool input' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe(
        'Preparing the tool input',
      ),
    );
    emit(2, 'item', {
      itemId: 'run-stream-progress',
      kind: 'status',
      phase: 'update',
      status: 'running',
      progress: { kind: 'tool-input', toolCallId: 'write-1', name: 'write', receivedChars: 64_000 },
    });
    emit(3, 'tool', {
      phase: 'input_delta',
      toolCallId: 'write-1',
      name: 'write',
      diff: { added: 12, removed: 0 },
    });
    emit(4, 'thinking', { text: 'Arguments are still arriving' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe(
        'Arguments are still arriving',
      ),
    );
    expect(document.querySelector('.process-tool')).toBeNull();

    emit(5, 'tool', {
      phase: 'start',
      toolCallId: 'write-1',
      name: 'write',
      args: { path: 'notes.txt' },
    });
    await vi.waitFor(() => expect(document.querySelectorAll('.process-tool')).toHaveLength(1));
    expect(document.querySelector('.process-tool-status.running')).not.toBeNull();
    expect(document.querySelector('.process-tool-input')?.textContent).toContain('notes.txt');
    emit(6, 'tool', {
      phase: 'result',
      toolCallId: 'write-1',
      name: 'write',
      result: 'File saved',
    });
    document.getElementById('processDetails')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('.process-tool-status.completed')).not.toBeNull(),
    );
    expect(document.querySelectorAll('.process-tool')).toHaveLength(1);
    expect(document.querySelector('.process-tool')?.textContent).toContain('File saved');
  });

  it('shows content-free native progress and keeps activity after a chat final until exact settled evidence', async () => {
    const { emit } = await mountThread();
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1', nativeRunId: 'run-1' } });
    emit(1, 'item', {
      itemId: 'run-stream-progress',
      kind: 'status',
      phase: 'update',
      status: 'running',
      progress: { kind: 'tool-input', toolCallId: 'write-1', name: 'write', receivedChars: 64_000 },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.run-activity-label')?.textContent).toBe(
        t('generating-tool-input'),
      ),
    );
    expect(document.querySelector('.run-activity-detail')?.textContent).toContain('64,000');
    expect(document.querySelector('.process-tool')).toBeNull();
    mock.notify('chrome/thread/stream', {
      threadId: 'one',
      kind: 'chat',
      event: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:one',
        state: 'final',
        message: { role: 'assistant', content: 'Reply' },
        seq: 2,
      },
    });
    expect(document.getElementById('runActivity')?.classList.contains('hidden')).toBe(false);
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', executionSettled: false },
    });
    expect(document.getElementById('send')?.classList.contains('stop')).toBe(true);
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'old-run', executionSettled: true },
    });
    expect(document.getElementById('send')?.classList.contains('stop')).toBe(true);
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', executionSettled: true, status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(document.getElementById('runActivity')?.classList.contains('hidden')).toBe(true),
    );
  });

  it('projects buffered request activity through the generated stream without replacing tool counters or animation nodes', async () => {
    const { emit } = await mountThread();
    const now = vi.spyOn(Date, 'now').mockReturnValue(60_000);
    try {
      mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1', nativeRunId: 'run-1' } });
      const activity = (at: number) => ({
        itemId: 'run-request-activity', kind: 'status', phase: 'update', status: 'running',
        at, progress: { kind: 'model-activity' },
      });
      emit(1, 'item', activity(35_000));
      await vi.waitFor(() =>
        expect(document.querySelector('.run-activity-label')?.textContent).toBe(t('receiving-model')),
      );
      const icon = document.querySelector('.run-activity-icon');
      const label = document.querySelector('.run-activity-label');
      expect(icon).not.toBeNull();
      expect(document.querySelector('.run-activity-detail')?.textContent).toBe(
        t('lastUpdate', { seconds: 25 }),
      );
      expect(document.querySelector('.run-activity-detail')?.textContent).not.toContain(
        t('receivedChars', { count: '0' }),
      );
      expect(document.querySelector('.process-tool')).toBeNull();

      emit(2, 'item', {
        itemId: 'run-stream-progress', kind: 'status', phase: 'update', status: 'running',
        progress: {
          kind: 'tool-input', toolCallId: 'wrapper-1', name: 'tool_call', receivedChars: 64_000,
        },
      });
      await vi.waitFor(() => expect(label?.textContent).toBe(t('generating-tool-input')));
      expect(document.querySelector('.run-activity-detail')?.textContent).toContain('64,000');
      const previousDetail = document.querySelector('.run-activity-detail')?.textContent;
      expect(previousDetail).toContain(t('lastUpdate', { seconds: 59 }));

      emit(3, 'item', activity(59_000));
      await vi.waitFor(() =>
        expect(document.querySelector('.run-activity-detail')?.textContent).not.toBe(previousDetail),
      );
      expect(label?.textContent).toBe(t('generating-tool-input'));
      expect(document.querySelector('.run-activity-detail')?.textContent).toContain('64,000');
      expect(document.querySelector('.run-activity-icon')).toBe(icon);
      expect(document.querySelector('.run-activity-label')).toBe(label);
      expect(document.querySelector('.run-activity-elapsed')?.getAttribute('aria-live')).toBe('off');
      expect(document.querySelector('.process-tool')).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it('keeps Stop acknowledgement and disconnect separate from settled execution', async () => {
    const { respond, emit } = await mountThread();
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1', nativeRunId: 'run-1' } });
    emit(1, 'thinking', { text: 'Working' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe('Working'),
    );
    mock.request.mockImplementation((method: string) =>
      method === 'turn/interrupt'
        ? Promise.resolve({ status: 'requested', executionSettled: false })
        : respond(method),
    );
    document.getElementById('send')!.click();
    await vi.waitFor(() =>
      expect(mock.request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'one',
        turnId: 'run-1',
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('.run-activity-label')?.textContent).toBe(t('stopping')),
    );
    expect(document.getElementById('send')?.classList.contains('stop')).toBe(true);
    mock.notify('connection/closed', {});
    expect(document.getElementById('send')?.classList.contains('stop')).toBe(true);
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe('Working');
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', status: 'interrupted', executionSettled: true },
    });
    await vi.waitFor(() =>
      expect(document.getElementById('send')?.classList.contains('stop')).toBe(false),
    );
  });

  it('preserves an uncertain submission and reconciles its exact identity without resending', async () => {
    const { respond } = await mountThread();
    let submitted: Record<string, unknown> | undefined;
    mock.request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'turn/start') {
        submitted = params;
        return Promise.reject(Object.assign(new Error('Connection lost'), { requestSent: true }));
      }
      return respond(method);
    });
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'Only once';
    prompt.dispatchEvent(new Event('input'));
    document.getElementById('send')!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('error')?.textContent).toBe(t('unknownSend')),
    );
    expect((submitted?.chrome as Record<string, unknown>)?.clientTurnId).toEqual(expect.any(String));
    expect(prompt.value).toBe('');
    expect(document.querySelector('.message.user:last-of-type')?.textContent).toContain(
      'Only once',
    );
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    prompt.value = 'A later draft';
    prompt.dispatchEvent(new Event('input'));
    mock.request.mockImplementation((method: string) =>
      method === 'thread/resume'
        ? Promise.resolve({
            thread: {
              id: 'one',
              turns: [
                {
                  id: 'history-1',
                  items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Question' }] }],
                },
              ],
            },
            activeTurn: { id: (submitted!.chrome as Record<string, unknown>).clientTurnId, status: 'unknown', executionSettled: false },
          })
        : respond(method),
    );
    mock.notify('connection/reconnected', {});
    await vi.waitFor(() =>
      expect(mock.request).toHaveBeenCalledWith('thread/resume', {
        excludeTurns: true,
        threadId: 'one',
        chrome: { includeDisplay: true, turnId: (submitted!.chrome as Record<string, unknown>).clientTurnId },
      }),
    );
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    expect(prompt.value).toBe('A later draft');
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    const select = document.getElementById('session') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.message.user')).toBeNull());
    select.value = 'one';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelectorAll('.message.user')).toHaveLength(2));
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    expect(
      [...document.querySelectorAll('.message.user')].some(node =>
        node.textContent?.includes('Only once'),
      ),
    ).toBe(true);
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });

  it('keeps client submission identity separate from the native stream root during recovery and Stop', async () => {
    const { thread, respond } = await mountThread();
    mock.request.mockImplementation((method: string) =>
      method === 'thread/resume'
        ? Promise.resolve({
            thread,
            activeTurn: {
              id: 'client-turn',
              nativeRunId: 'native-root',
              status: 'inProgress',
              executionSettled: false,
            },
          })
        : respond(method),
    );
    mock.notify('connection/reconnected', {});
    await vi.waitFor(() =>
      expect(document.getElementById('send')?.classList.contains('stop')).toBe(true),
    );
    mock.notify('chrome/thread/stream', {
      threadId: 'one',
      kind: 'agent',
      event: {
        runId: 'native-root',
        sessionKey: 'agent:main:justdo:one',
        sessionId: null,
        lifecycleGeneration: null,
        agentId: 'main',
        spawnedBy: null,
        agentSeq: 1,
        frameSeq: 1,
        deliveryEvent: 'agent',
        timestamp: Date.now(),
        stream: 'thinking',
        data: { text: 'Native stream' },
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe('Native stream'),
    );
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'native-root', executionSettled: true },
    });
    expect(document.getElementById('send')?.classList.contains('stop')).toBe(true);
    document.getElementById('send')!.click();
    await vi.waitFor(() =>
      expect(mock.request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'one',
        turnId: 'client-turn',
      }),
    );
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: {
        id: 'client-turn',
        nativeRunId: 'native-root',
        status: 'interrupted',
        executionSettled: true,
      },
    });
    await vi.waitFor(() =>
      expect(document.getElementById('send')?.classList.contains('stop')).toBe(false),
    );
  });

  it('only adopts the explicitly bound new run when old frames arrive while its send acknowledgement is pending', async () => {
    const { respond, emit } = await mountThread();
    let resolveTurn!: (value: unknown) => void;
    let clientTurnId: unknown;
    mock.request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'turn/start')
        return new Promise(resolve => {
          clientTurnId = (params.chrome as Record<string, unknown>).clientTurnId;
          resolveTurn = resolve;
        });
      return respond(method);
    });
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'A new task';
    prompt.dispatchEvent(new Event('input'));
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(resolveTurn).toBeDefined());
    emit(100, 'assistant', { text: 'Delayed previous answer' }, 'one', 'previous-native-run');
    emit(1, 'thinking', { text: 'Only the new task' }, 'one', 'current-native-run');
    expect(document.querySelector('.message.assistant')).toBeNull();
    expect(document.querySelector('.message-detail')).toBeNull();
    // This exact native identity can be confirmed before the RPC response.
    // Binding must immediately paint the eligible buffered frame, even if no
    // additional stream event arrives to schedule another render.
    mock.notify('turn/started', {
      threadId: 'one',
      turn: { id: clientTurnId, nativeRunId: 'current-native-run' },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe(
        'Only the new task',
      ),
    );
    expect(document.getElementById('messages')?.textContent).not.toContain(
      'Delayed previous answer',
    );
    emit(101, 'thinking', { text: 'Still the previous task' }, 'one', 'previous-native-run');
    expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe(
      'Only the new task',
    );
    resolveTurn({ turn: { id: clientTurnId, nativeRunId: 'current-native-run' } });
    await vi.waitFor(() =>
      expect((document.getElementById('session') as HTMLSelectElement).disabled).toBe(false),
    );
    expect(document.querySelectorAll('.message.user')).toHaveLength(2);
    expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe(
      'Only the new task',
    );
    expect(document.getElementById('messages')?.textContent).not.toContain('previous');
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });

  it('restores an editable draft only when transport proves the turn was never sent', async () => {
    const { respond } = await mountThread();
    mock.request.mockImplementation((method: string) =>
      method === 'turn/start'
        ? Promise.reject(Object.assign(new Error('Not sent'), { requestSent: false }))
        : respond(method),
    );
    (document.getElementById('includePage') as HTMLInputElement).checked = false;
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'Unsent draft';
    prompt.dispatchEvent(new Event('input'));
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(document.getElementById('error')?.textContent).toBe('Not sent'));
    expect(prompt.value).toBe('Unsent draft');
    expect(
      [...document.querySelectorAll('.message.user')].some(node =>
        node.textContent?.includes('Unsent draft'),
      ),
    ).toBe(false);
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('freezes a cold unknown run without fabricating an input and only enables Stop after exact acceptance', async () => {
    const { thread, respond } = await mountThread();
    let status = 'unknown';
    mock.request.mockImplementation((method: string) =>
      method === 'thread/resume'
        ? Promise.resolve({
            thread,
            activeTurn: {
              id: 'previous-client-turn',
              nativeRunId: 'native-root',
              status,
              executionSettled: status === 'completed',
            },
          })
        : respond(method),
    );
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
    prompt.value = 'A new draft';
    prompt.dispatchEvent(new Event('input'));
    mock.notify('connection/reconnected', {});
    await vi.waitFor(() =>
      expect(document.getElementById('error')?.textContent).toBe(t('unknownExecution')),
    );
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
    expect(document.querySelector('.message.user')?.textContent).toContain('Question');
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
    document.getElementById('refresh')!.click();
    await vi.waitFor(() =>
      expect(mock.request).toHaveBeenCalledWith('thread/resume', {
        excludeTurns: true,
        threadId: 'one',
        chrome: { includeDisplay: true, turnId: 'previous-client-turn' },
      }),
    );
    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    status = 'inProgress';
    document.getElementById('refresh')!.click();
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(document.getElementById('send')?.classList.contains('stop')).toBe(true);
    status = 'completed';
    document.getElementById('refresh')!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('send')?.classList.contains('stop')).toBe(false),
    );
    expect(prompt.value).toBe('A new draft');
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
  });

  it('keeps live thinking visible and retains completed-summary choices during stream updates', async () => {
    const { emit } = await mountThread();
    emit(1, 'thinking', { text: 'Considering' });
    await vi.waitFor(() =>
      expect(document.querySelector('.process-live')?.textContent).toContain('Considering'),
    );
    emit(2, 'thinking', { text: 'Considering more' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message-detail')?.textContent?.trim()).toBe(
        'Considering more',
      ),
    );
    expect(document.querySelector('.process-live details.process-thinking')).toBeNull();
    emit(3, 'assistant', { text: 'Answer' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent?.trim()).toBe('Answer'),
    );
    const group = document.querySelector<HTMLDetailsElement>('.process-summary-group')!;
    expect(group.open).toBe(false);
    group.querySelector<HTMLElement>('summary')!.click();
    emit(4, 'assistant', { text: 'Answer continues' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('continues'),
    );
    expect(document.querySelector('.process-summary-group')).toBe(group);
    expect(group.open).toBe(true);
    expect(group.textContent).toContain('Considering more');
  });

  it('automatically collapses thinking when content starts without a manual preference', async () => {
    const { emit } = await mountThread();
    emit(1, 'thinking', { text: 'Considering' });
    await vi.waitFor(() =>
      expect(document.querySelector('.process-live')?.textContent).toContain('Considering'),
    );
    emit(2, 'assistant', { text: 'Answer' });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDetailsElement>('.process-summary-group')?.open).toBe(
        false,
      ),
    );
    expect(document.querySelector('.completed-process')).toBeNull();
  });

  it('keeps growing live text visible when lagging history includes a shorter rawMessage', async () => {
    const { thread, emit } = await mountThread();
    emit(1, 'assistant', { text: 'Hello' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message.assistant')?.textContent?.trim()).toBe('Hello'),
    );
    const laggingHistory = {
      ...thread,
      turns: [
        {
          ...thread.turns[0],
          items: [
            ...thread.turns[0].items,
            {
              id: 'history-body',
              type: 'agentMessage',
              text: 'Hello',
              rawMessage: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
            },
          ],
        },
      ],
    };
    mock.notify('chrome/thread/updated', { threadId: 'one', thread: laggingHistory });
    emit(2, 'assistant', { text: 'Hello world' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message.assistant')?.textContent?.trim()).toBe('Hello world'),
    );
    // The next poll can still carry the older native body. The rich renderer
    // must continue displaying the longer, admitted live projection.
    mock.notify('chrome/thread/updated', { threadId: 'one', thread: laggingHistory });
    emit(3, 'assistant', { text: 'Hello world, still streaming' });
    await vi.waitFor(() =>
      expect(document.querySelector('.message.assistant')?.textContent?.trim()).toBe(
        'Hello world, still streaming',
      ),
    );
    expect(document.querySelectorAll('.message.assistant')).toHaveLength(1);
  });

  it('keeps historical thinking collapsed and uses matching header icon geometry', async () => {
    const { thread } = await mountThread();
    mock.notify('chrome/thread/updated', {
      threadId: 'one',
      thread: {
        ...thread,
        turns: [{ id: 'history-1', items: [{ type: 'reasoning', content: ['Past thought'] }] }],
      },
    });
    expect(document.querySelector<HTMLDetailsElement>('.process-summary-group')?.open).toBe(false);
    for (const id of ['processDetails', 'refresh', 'settings']) {
      expect(document.getElementById(id)?.className).toBe('icon');
      expect(document.querySelector(`#${id} svg`)?.getAttribute('viewBox')).toBe('0 0 24 24');
    }
  });

  it('keeps the current subscription and final history when same-thread refreshes race', async () => {
    const { thread, respond, emit } = await mountThread();
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1', nativeRunId: 'run-1' } });
    emit(1, 'assistant', { text: 'Partial text' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Partial'),
    );
    const reads: Array<(value: unknown) => void> = [];
    mock.request.mockImplementation((method: string) =>
      method === 'thread/resume' ? new Promise(resolve => reads.push(resolve)) : respond(method),
    );
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', status: 'completed', executionSettled: true, error: null },
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
      if (method === 'thread/resume') return new Promise(resolve => reads.push(resolve));
      if (method === 'turn/interrupt') {
        mock.notify('turn/completed', {
          threadId: 'one',
          turn: { id: 'run-1', status: 'interrupted', executionSettled: true, error: null },
        });
        return Promise.resolve({});
      }
      return respond(method);
    });
    document.getElementById('send')!.click();
    await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(1));
    // The RPC response can supersede its preceding completion notification's refresh.
    for (const resolve of reads) resolve({ thread });
    document.getElementById('processDetails')!.click();
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
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1', nativeRunId: 'run-1' } });
    emit(1, 'assistant', { text: 'Complete streamed reply' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('Complete'),
    );
    mock.request.mockImplementation((method: string) =>
      method === 'thread/resume' ? Promise.reject(new Error('History unavailable')) : respond(method),
    );
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', status: 'completed', executionSettled: true, error: null },
    });
    await vi.waitFor(() =>
      expect(document.getElementById('error')?.textContent).toContain('History unavailable'),
    );
    expect(document.querySelector('.assistant')?.textContent).toContain('Complete streamed reply');
    mock.request.mockImplementation((method: string) =>
      method === 'thread/resume'
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
      mock.request.mockImplementation((method: string, params: Record<string, unknown>) => {
        if (method === 'turn/start')
          return Promise.resolve({ turn: { id: (params.chrome as Record<string, unknown>).clientTurnId, nativeRunId: 'run-1' } });
        if (method === 'thread/resume') return Promise.reject(new Error('History unavailable'));
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
      await vi.waitFor(() => expect(document.querySelector('.process-live')).not.toBeNull());
      const submitted = () =>
        [...document.querySelectorAll('.message.user')].filter(
          node => node.textContent?.trim() === text,
        );
      expect(submitted()).toHaveLength(count);
      emit(2, 'assistant', { text: 'Hello back' });
      await vi.waitFor(() =>
        expect(document.querySelector('.assistant')?.textContent).toContain('Hello back'),
      );
      mock.notify('chrome/thread/updated', {
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
    let submittedTurnId: unknown;
    mock.request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start')
        return new Promise(resolve => {
          resolveThread = resolve;
        });
      if (method === 'turn/start')
        return new Promise(resolve => {
          submittedTurnId = (params.chrome as Record<string, unknown>).clientTurnId;
          resolveTurn = resolve;
        });
      if (method === 'thread/list')
        return Promise.resolve({
          data: [
            { id: 'one', status: { type: 'idle' } },
            { id: 'two', status: { type: 'active' } },
          ],
        });
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: 'two', turns: [] } });
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
    resolveTurn({ turn: { id: submittedTurnId, nativeRunId: 'run-1' } });
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
    expect(document.querySelector('.process-live')).not.toBeNull();
    mock.notify('chrome/thread/updated', {
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
      'plugins/chrome-extensions/chrome-assistant/conversation-overlay/sidepanel.html',
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
      if (method === 'thread/resume') return { thread };
      if (method === 'chrome/composer/options')
        return { models: [{ id: 'p/m', name: 'Model' }], modelRef: 'p/m', permissionMode: 'ask' };
      return {};
    });
    await import('../conversation-overlay/sidepanel.js');
    const select = document.getElementById('session') as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(2));
    select.value = 'one';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.querySelector('.message.user')?.textContent).toContain('Question'),
    );
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'run-1', nativeRunId: 'run-1' } });
    const send = (seq: number, stream: string, data: Record<string, unknown>) =>
      mock.notify('chrome/thread/stream', {
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
    await vi.waitFor(() => expect(document.querySelector('.process-live')).not.toBeNull());
    send(2, 'thinking', { thinking: 'Inspect the file' });
    send(3, 'tool', { phase: 'start', name: 'read', toolCallId: 't1', args: { path: 'a.txt' } });
    await vi.waitFor(() => expect(document.querySelector('.process-tool')).not.toBeNull());
    document.getElementById('processDetails')!.click();
    (document.querySelector('.process-tool') as HTMLDetailsElement).open = true;
    const toolNode = document.querySelector('.process-tool');
    send(4, 'tool', { phase: 'result', name: 'read', toolCallId: 't1', result: 'File content' });
    send(5, 'assistant', { text: '**Hello**' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant strong')?.textContent).toBe('Hello'),
    );
    const userNode = document.querySelector('.message.user');
    const processNode = document.querySelector('.process-summary-group');
    send(6, 'assistant', { text: '**Hello** world' });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('world'),
    );
    expect(document.querySelector('.message.user')).toBe(userNode);
    expect(document.querySelector('.process-summary-group')).toBe(processNode);
    expect((document.querySelector('.process-tool') as HTMLDetailsElement).open).toBe(true);
    // A lagging history update must not remove live text or rebuild old bubbles.
    mock.notify('chrome/thread/updated', { threadId: 'one', thread });
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
    mock.notify('turn/completed', {
      threadId: 'one',
      turn: { id: 'run-1', executionSettled: true, error: null },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.assistant')?.textContent).toContain('world!'),
    );
    expect((document.querySelector('.completed-process') as HTMLDetailsElement).open).toBe(true);
    expect(document.querySelector('.process-tool')).toBe(toolNode);
    expect((document.querySelector('.process-tool') as HTMLDetailsElement).open).toBe(true);
  });
});
