import { describe, expect, it, vi } from 'vitest';

import { ExternalSessionStatus } from '../../../../shared/integrations/externalSession';
import type { NormalizedAgentEvent } from '../../../../shared/openclaw/agentEvent';
import { ApprovalKind } from '../../../../shared/security/approvals';
import {
  ExternalAgentBusyError,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
  type ExternalAgentThreadHistory,
} from '../../shared/externalAgentTypes';
import type { ExternalClientResources } from '../../shared/externalClientResources';
import { CodexAppServerEventHub } from './codexAppServerEventHub';
import { type CodexAppServerBackend, CodexAppServerSession } from './codexAppServerSession';
import type { ExternalAppServerOptions } from './externalAppServerBinding';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function initialize(session: CodexAppServerSession) {
  await session.receive({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
  await session.receive({ method: 'initialized' });
}
const event = (data: Record<string, unknown>, stream = 'tool'): NormalizedAgentEvent => ({
  runId: 'native',
  sessionKey: 'native-key',
  sessionId: null,
  lifecycleGeneration: null,
  agentId: 'main',
  spawnedBy: null,
  agentSeq: 1,
  frameSeq: 1,
  deliveryEvent: 'agent',
  stream,
  timestamp: 1,
  data,
});
function fixture(options: ExternalAppServerOptions = {}) {
  const output: Array<Record<string, unknown>> = [];
  const thread = { id: 'thread', cwd: '/task', agentId: 'main', modelRef: 'provider/model' };
  let created = 0;
  const stored = new Map([[thread.id, { thread, name: 'Fixture' }]]);
  const describe = (id: string) => {
    const entry = stored.get(id);
    if (!entry) throw new Error('Thread is not owned by this connection.');
    return { ...entry.thread, name: entry.name, createdAt: 1000, updatedAt: 2000, permissionMode: 'full' as const, status: 'completed' as const };
  };
  const backend: CodexAppServerBackend = {
    models: () => [{ id: 'provider/model', name: 'Configured model', isDefault: true }],
    start: vi.fn(async params => {
      const current = { ...thread, id: ++created === 1 ? 'thread' : `thread-${created}`, ...(params.model ? { modelRef: params.model } : {}) };
      stored.set(current.id, { thread: current, name: 'Fixture' });
      return current;
    }),
    resume: vi.fn(async id => ({ ...describe(id) })),
    describe: vi.fn(describe),
    history: vi.fn(async id => { describe(id); return { threadId: id, messages: [], runs: [] }; }),
    setName: vi.fn((id, value) => { describe(id); stored.get(id)!.name = value.trim(); }),
    run: vi.fn(async () => 'done'),
  };
  const session = new CodexAppServerSession(backend, value =>
    output.push(value as Record<string, unknown>), options);
  const request = async (method: string, params = {}) => {
    await session.receive({ id: output.length + 1, method, params: method === 'initialize'
      ? { clientInfo: { name: 'test-client', version: '1.0.0' }, ...params }
      : method === 'thread/resume' ? { excludeTurns: true, ...params } : params });
    if (method === 'initialize') await session.receive({ method: 'initialized' });
  };
  return { session, backend, output, request };
}

describe('Codex app-server session', () => {
  it('sends actual image-only input and canonical content while denying images for a text-only selected model', async () => {
    const h = fixture();
    await h.request('initialize');
    await h.request('thread/start');
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLFsAAAAASUVORK5CYII=';
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'image', url }] });
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32602 } });
    expect(h.backend.run).not.toHaveBeenCalled();
    h.backend.models = () => [{ id: 'provider/model', name: 'Vision', isDefault: true, inputModalities: ['text', 'image'] }];
    h.backend.run = vi.fn(async (_thread, _run, text, notify, _signal, hooks) => {
      expect(text).toBe('');
      expect(hooks?.attachments).toEqual([{ name: 'image-1.png', mimeType: 'image/png', base64Data: url.split(',')[1] }]);
      notify(event({ phase: 'start' }, 'lifecycle'));
      return 'Image answer';
    });
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'image', url }] });
    await tick();
    expect(h.backend.run).toHaveBeenCalledTimes(1);
    const userItems = h.output.filter(frame => frame.method === 'item/completed' &&
      (frame.params as { item?: { type?: string } })?.item?.type === 'userMessage');
    expect(userItems).toHaveLength(1);
    expect(userItems[0]).toMatchObject({ params: { item: { content: [{ type: 'image', url }] } } });
    await h.session.close();
  });
  it('requires the complete official handshake before admitting work', async () => {
    const { session, backend, output } = fixture();
    await session.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'client', version: '1' } } });
    expect(output.at(-1)).toMatchObject({ result: { platformFamily: expect.any(String), codexHome: expect.any(String) } });
    await session.receive({ id: 2, method: 'thread/start' });
    expect(output.at(-1)).toMatchObject({ error: { code: -32600 } });
    expect(backend.start).not.toHaveBeenCalled();
    await session.receive({ method: 'initialized', params: null });
    await session.receive({ id: 3, method: 'thread/start' });
    expect(output.at(-1)).toMatchObject({ result: { modelProvider: 'provider', thread: { name: 'Fixture', createdAt: 1 } } });
    await session.close();
  });

  it('rejects history resume when an adapter lacks history rather than inventing empty history', async () => {
    const { session, backend, output, request } = fixture();
    delete backend.history;
    await request('initialize');
    await session.receive({ id: 'history-resume', method: 'thread/resume', params: { threadId: 'thread' } });
    expect(output.at(-1)).toMatchObject({ error: { code: -32601 } });
    expect(backend.resume).not.toHaveBeenCalled();
    await request('thread/resume', { threadId: 'thread', excludeTurns: true });
    expect(output.at(-1)).toHaveProperty('result.thread.id', 'thread');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'task' }], disabledPluginIds: [] });
    expect(output.at(-1)).toMatchObject({ error: { code: -32602 } });
    expect(backend.run).not.toHaveBeenCalled();
    await session.close();
  });

  it('keeps an owned resumed model selection consistent in metadata reads and provider filters', async () => {
    const { session, backend, output, request } = fixture();
    backend.resume = vi.fn(async () => ({ id: 'thread', cwd: '/task', agentId: 'main', modelRef: 'selected/new-model' }));
    backend.list = () => [backend.describe!('thread')];
    await request('initialize');
    await request('thread/resume', { threadId: 'thread', model: 'selected/new-model' });
    expect(output.at(-1)).toHaveProperty('result.model', 'selected/new-model');
    await request('thread/read', { threadId: 'thread' });
    expect(output.at(-1)).toHaveProperty('result.thread.model', 'selected/new-model');
    await request('thread/list', { modelProviders: ['selected'] });
    expect(output.at(-1)).toMatchObject({ result: { data: [{ model: 'selected/new-model', modelProvider: 'selected' }] } });
    expect(backend.run).not.toHaveBeenCalled();
    await session.close();
  });

  it('retires the shared connection when a deferred notification loses its output', async () => {
    const h = fixture();
    const output: Array<Record<string, unknown>> = [];
    const session = new CodexAppServerSession(h.backend, message => {
      const value = message as Record<string, unknown>;
      if (value.method === 'thread/started') throw new Error('Fixture output failed');
      output.push(value);
    });
    await session.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
    await session.receive({ method: 'initialized' });
    await session.receive({ id: 2, method: 'thread/start', params: {} });
    await session.receive({ id: 'queued-before-loss', method: 'turn/start', params: {
      threadId: 'thread', input: [{ type: 'text', text: 'admitted but must not launch after output loss' }],
    } });
    await tick();
    const before = [...output];
    await session.receive({ id: 3, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'must not launch' }] } });
    await session.receive({ id: 4, method: 'thread/name/set', params: { threadId: 'thread', name: 'must not mutate' } });
    expect(h.backend.run).not.toHaveBeenCalled();
    expect(h.backend.setName).not.toHaveBeenCalled();
    expect(output).toEqual(before);
    expect(session.ownedThreadIds()).toEqual([]);
    await session.close();
    await h.session.close();
  });

  it('retires a running connection when an item notification loses output and blocks later work', async () => {
    const h = fixture();
    h.backend.run = vi.fn(async (_thread, _run, _text, emit, signal) => {
      emit(event({ text: 'Fixture output' }, 'assistant'));
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(ExternalAgentStreamError);
      throw new ExternalAgentCancelledError('Native cancellation after output loss');
    });
    const session = new CodexAppServerSession(h.backend, message => {
      if ((message as Record<string, unknown>).method === 'item/started') throw new Error('Fixture item output failed');
    });
    await session.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
    await session.receive({ method: 'initialized' });
    await session.receive({ id: 2, method: 'thread/start', params: {} });
    await session.receive({ id: 3, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'task' }] } });
    await tick();
    await session.receive({ id: 4, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'must not retry' }] } });
    await session.receive({ id: 5, method: 'thread/name/set', params: { threadId: 'thread', name: 'must not mutate' } });
    expect(h.backend.run).toHaveBeenCalledOnce();
    expect(h.backend.setName).not.toHaveBeenCalled();
    await session.close();
    await h.session.close();
  });

  it('reads and renames persisted metadata without opening a thread or starting execution', async () => {
    const { session, backend, output, request } = fixture();
    backend.list = () => [backend.describe!('thread')];
    await request('initialize');
    await request('thread/list', { limit: 1 });
    expect(output.at(-1)).toMatchObject({ result: { data: [{ id: 'thread', status: { type: 'notLoaded' }, turns: [] }] } });
    await request('thread/read', { threadId: 'thread', includeTurns: true });
    expect(output.at(-1)).toMatchObject({ result: { thread: { turns: [] } } });
    expect(backend.history).toHaveBeenCalledExactlyOnceWith('thread');
    await request('thread/name/set', { threadId: 'thread', name: ' Renamed ' });
    expect(output.at(-1)).toMatchObject({ result: {} });
    const responsePosition = output.length - 1;
    await tick();
    const notificationPosition = output.findIndex(message => message.method === 'thread/name/updated');
    expect(notificationPosition).toBeGreaterThan(responsePosition);
    expect(output[notificationPosition]).toMatchObject({ params: { threadId: 'thread', threadName: 'Renamed' } });
    await request('thread/read', { threadId: 'thread' });
    expect(output.at(-1)).toMatchObject({ result: { thread: { name: 'Renamed' } } });
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.run).not.toHaveBeenCalled();
    await session.close();
  });

  it('publishes thread creation after the response and reports loaded IDs without claiming history', async () => {
    const { session, output, request } = fixture();
    await request('initialize');
    await request('thread/loaded/list');
    expect(output.at(-1)).toMatchObject({ result: { data: [], nextCursor: null } });
    await request('thread/start');
    const responsePosition = output.length - 1;
    await tick();
    const notificationPosition = output.findIndex(message => message.method === 'thread/started');
    expect(notificationPosition).toBeGreaterThan(responsePosition);
    await request('thread/loaded/list');
    expect(output.at(-1)).toMatchObject({ result: { data: ['thread'], nextCursor: null } });
    await request('thread/read', { threadId: 'thread', includeTurns: false });
    expect(output.at(-1)).toMatchObject({ result: { thread: { status: { type: 'idle' }, turns: [] } } });
    await session.close();
  });

  it('keeps business notifications from dispatching work after initialization', async () => {
    const { session, backend, output, request } = fixture();
    await session.receive({ method: 'initialized' });
    await session.receive({ method: 'thread/start', params: {} });
    expect(output).toEqual([]);
    expect(backend.start).not.toHaveBeenCalled();
    await request('initialize');
    const initializedOutput = [...output];

    await session.receive({ method: 'initialized' });
    await session.receive({ method: 'thread/start', params: {} });
    await session.receive({ method: 'turn/start', params: { input: [{ type: 'text', text: 'task' }] } });

    expect(output).toEqual(initializedOutput);
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.run).not.toHaveBeenCalled();
    await request('thread/start');
    expect(backend.start).toHaveBeenCalledOnce();
    expect(output.at(-1)).toMatchObject({ result: { thread: { id: 'thread' } } });
    await session.close();
  });

  it('sends the local turn reply before starting native execution or progress', async () => {
    const { session, backend, output, request } = fixture();
    let replyPresentAtLaunch = false;
    backend.run = vi.fn(async () => {
      replyPresentAtLaunch = output.some(value => value.id === 'turn-admission' && 'result' in value);
      return 'Exact completed reply';
    });
    await request('initialize');
    await request('thread/start');

    await session.receive({
      id: 'turn-admission',
      method: 'turn/start',
      params: { threadId: 'thread', input: [{ type: 'text', text: 'task' }] },
    });

    expect(backend.run).not.toHaveBeenCalled();
    const replyIndex = output.findIndex(value => value.id === 'turn-admission');
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(output.some(value => value.method === 'turn/started')).toBe(false);
    await tick();
    expect(replyPresentAtLaunch).toBe(true);
    expect(output.findIndex(value => value.method === 'turn/started')).toBeGreaterThan(replyIndex);
    expect(output.findLast(value => value.method === 'turn/completed')).toMatchObject({
      method: 'turn/completed',
      params: { turn: { status: 'completed' } },
    });
    await session.close();
  });

  it('applies shared notification opt-out without suppressing execution or other item events', async () => {
    const { session, backend, output, request } = fixture();
    await request('initialize', {
      capabilities: { optOutNotificationMethods: ['item/agentMessage/delta'] },
    });
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'task' }] });
    await tick();

    expect(backend.run).toHaveBeenCalledOnce();
    expect(output.some(value => value.method === 'item/agentMessage/delta')).toBe(false);
    expect(output.some(value => value.method === 'item/started')).toBe(true);
    expect(output.some(value => value.method === 'item/completed')).toBe(true);
    expect(output.findLast(value => value.method === 'turn/completed')).toMatchObject({ method: 'turn/completed' });
    await session.close();
  });

  it('keeps thread operations bound to their CLI ownership when the shared router extracts them', async () => {
    const { session, backend, output, request } = fixture();
    await request('initialize');
    await request('thread/resume', { threadId: 'thread', cwd: null, model: null });

    expect(backend.resume).toHaveBeenCalledExactlyOnceWith('thread', {
      cwd: undefined,
      model: undefined,
    });
    expect(backend.start).not.toHaveBeenCalled();
    expect(output.at(-1)).toMatchObject({ result: { thread: { id: 'thread' } } });
    await request('thread/name/set', { threadId: 'thread', name: 'Client presentation title' });
    expect(output.at(-1)).toMatchObject({ result: {} });
    await request('thread/name/set', { threadId: 'foreign', name: 'Foreign title' });
    expect(output.at(-1)).toMatchObject({
      error: { code: -32000, message: 'Thread is not owned by this connection.' },
    });
    await request('thread/start');
    expect(output.at(-1)).toHaveProperty('error');
    expect(backend.start).toHaveBeenCalledOnce();
    await session.close();
  });

  it('reserves a resumed identity while asynchronous opening is still pending', async () => {
    const { session, backend, output, request } = fixture();
    const thread = { id: 'thread', cwd: '/task', agentId: 'main' };
    let finish!: (value: typeof thread) => void;
    backend.resume = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await request('initialize');
    const opening = session.receive({ id: 'first-open', method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } });

    await session.receive({ id: 'second-open', method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } });

    expect(backend.resume).toHaveBeenCalledOnce();
    expect(output.at(-1)).toMatchObject({
      id: 'second-open',
      error: { message: 'This thread is already opening.' },
    });
    finish(thread);
    await opening;
    expect(output.at(-1)).toMatchObject({ id: 'first-open', result: { thread: { id: thread.id } } });
    await session.close();
  });

  it('suppresses a late thread response after shared connection closure', async () => {
    const { session, backend, output, request } = fixture();
    const thread = { id: 'thread', cwd: '/task', agentId: 'main' };
    let finish!: (value: typeof thread) => void;
    backend.start = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await request('initialize');
    const opening = session.receive({ id: 'late-open', method: 'thread/start', params: {} });
    const beforeClose = [...output];

    const closed = session.close();
    expect(session.close()).toBe(closed);
    await closed;
    finish(thread);
    await opening;
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'task' }] });

    expect(output).toEqual(beforeClose);
    expect(backend.run).not.toHaveBeenCalled();
  });

  it('ignores a foreign interrupt and close aborts the exact owned run while awaiting its settlement', async () => {
    const { session, backend, output, request } = fixture();
    let nativeSignal!: AbortSignal;
    let finish!: (value: string) => void;
    backend.run = vi.fn(async (_thread, _run, _text, _notify, signal) => {
      nativeSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    });
    await request('initialize');
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'task' }] });
    await tick();
    await request('turn/interrupt', { threadId: 'thread', turnId: 'foreign-turn' });
    expect(output.at(-1)).toMatchObject({ error: { message: 'Turn is not active.' } });
    expect(nativeSignal.aborted).toBe(false);
    const reason = new ExternalAgentStreamError('Console transport closed');
    const beforeClose = [...output];
    let settled = false;

    const closed = session.close(reason);
    expect(session.close(reason)).toBe(closed);
    void closed.then(() => { settled = true; });
    await Promise.resolve();
    expect(nativeSignal.reason).toBe(reason);
    expect(settled).toBe(false);
    finish('Exact completed reply');
    await closed;

    expect(settled).toBe(true);
    expect(output).toEqual(beforeClose);
    expect(backend.run).toHaveBeenCalledOnce();
  });

  it.each([
    { cwd: 42 },
    { model: {} },
    { config: [] },
    { config: 'unexpected' },
    { modelProvider: 'other' },
    { profile: 'other' },
    { developerInstructions: 'override' },
    { baseInstructions: 'override' },
    { includeApplyPatchTool: false },
  ])('rejects unsupported or malformed thread options: %j', async params => {
    const { backend, output, request } = fixture();
    await request('initialize');
    await request('thread/start', params);
    expect(output.at(-1)).toHaveProperty('error');
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('accepts nullable protocol placeholders and reports the configured default model independent of ordering', async () => {
    const { backend, output, request } = fixture();
    backend.models = () => [
      { id: 'other/model', name: 'Other', isDefault: false },
      { id: 'provider/model', name: 'Configured model', isDefault: true },
    ];
    await request('initialize');
    await request('model/list');
    expect(output.at(-1)).toMatchObject({
      result: { data: [{ isDefault: false }, { isDefault: true }] },
    });
    await request('thread/start', {
      model: null,
      modelProvider: null,
      profile: null,
      cwd: null,
      approvalPolicy: null,
      sandbox: null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(output.at(-1)).not.toHaveProperty('error');
    expect(backend.start).toHaveBeenCalledOnce();
    expect(output.at(-1)).toMatchObject({ result: { model: 'provider/model' } });
  });

  it.each(['cwd', 'approvalPolicy', 'sandboxPolicy', 'outputSchema'])(
    'rejects turn override %s',
    async key => {
      const { backend, output, request } = fixture();
      await request('initialize');
      await request('thread/start');
      await request('turn/start', {
        threadId: 'thread',
        input: [{ type: 'text', text: 'task' }],
        [key]: 'override',
      });
      expect(output.at(-1)).toHaveProperty('error');
      expect(backend.run).not.toHaveBeenCalled();
    },
  );

  it('reports oversized stream output as failure without throwing into the event emitter', async () => {
    const { session, backend, output, request } = fixture();
    backend.run = async (_thread, _run, _text, notify, signal) => {
      expect(() =>
        notify(event({ text: 'x'.repeat(2 * 1024 * 1024 + 1) }, 'assistant')),
      ).not.toThrow();
      expect(signal.aborted).toBe(true);
      return 'late result';
    };
    await request('initialize');
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] });
    await tick();
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          turn: expect.objectContaining({
            status: 'failed',
            error: expect.objectContaining({ message: 'Assistant output exceeded the event limit.' }),
          }),
        }),
      }),
    );
    expect(output.some(value => value.method === 'item/completed')).toBe(false);
    await session.close();
  });

  it('emits tool progress before completion and keeps commentary separate from the deliverable', async () => {
    const { session, backend, output, request } = fixture();
    let finish!: (text: string) => void;
    backend.run = vi.fn(async (_thread, _run, _text, notify) => {
      notify(event({ text: 'Reading the fixture.' }, 'assistant'));
      notify(
        event({ phase: 'start', name: 'read', toolCallId: 'call', args: { path: 'fixture' } }),
      );
      notify(event({ phase: 'start', name: 'read', toolCallId: 'call' }));
      return new Promise<string>(resolve => {
        finish = resolve;
      });
    });
    await request('initialize');
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] });
    await tick();
    expect(output.filter(value => value.method === 'item/started')).toHaveLength(2);
    expect(output.some(value => value.method === 'turn/completed')).toBe(false);
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'item/completed',
        params: expect.objectContaining({
          item: expect.objectContaining({ phase: 'commentary', text: 'Reading the fixture.' }),
        }),
      }),
    );
    finish('Verified');
    await tick();
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'item/completed',
        params: expect.objectContaining({
          item: expect.objectContaining({ phase: 'final_answer', text: 'Verified' }),
        }),
      }),
    );
    await session.close();
  });

  it('routes cancellation to the active run and preserves an exact success racing that request', async () => {
    const { session, backend, output, request } = fixture();
    let finish!: () => void;
    let aborted = false;
    backend.run = async (_thread, _run, _text, _notify, signal) =>
      new Promise<string>(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        finish = () => resolve('late answer');
      });
    await request('initialize');
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] });
    await tick();
    const started = output.find(value => value.method === 'turn/started')!;
    const turnId = (started.params as { turnId: string }).turnId;
    await request('turn/interrupt', { threadId: 'thread', turnId });
    expect(aborted).toBe(true);
    expect(output.some(value => value.method === 'turn/completed')).toBe(false);
    finish();
    await tick();
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          turn: expect.objectContaining({ id: turnId, status: 'completed' }),
        }),
      }),
    );
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'item/completed',
        params: expect.objectContaining({
          item: expect.objectContaining({ text: 'late answer', phase: 'final_answer' }),
        }),
      }),
    );
    await session.close();
  });

  it.each([false, true])(
    'only exact typed cancellation interrupts a turn (local stop %s)',
    async stopped => {
      const { session, backend, output, request } = fixture();
      let cancel!: () => void;
      backend.run = async () =>
        new Promise<string>((_resolve, reject) => {
          cancel = () => reject(new ExternalAgentCancelledError('Native cancellation'));
        });
      await request('initialize');
      await request('thread/start');
      await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] });
      await tick();
      const started = output.find(value => value.method === 'turn/started')!;
      const turnId = (started.params as { turnId: string }).turnId;
      if (stopped) await request('turn/interrupt', { threadId: 'thread', turnId });
      cancel();
      await tick();
      expect(output).toContainEqual(
        expect.objectContaining({
          method: 'turn/completed',
          params: expect.objectContaining({
            turn: expect.objectContaining({ id: turnId, status: 'interrupted', error: null }),
          }),
        }),
      );
      await session.close();
    },
  );

  it('keeps exact failure as failure when a local stop was requested', async () => {
    const { session, backend, output, request } = fixture();
    let fail!: () => void;
    backend.run = async () =>
      new Promise<string>((_resolve, reject) => {
        fail = () => reject(new Error('Native failure'));
      });
    await request('initialize');
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] });
    await tick();
    const turnId = (
      output.find(value => value.method === 'turn/started')!.params as { turnId: string }
    ).turnId;
    await request('turn/interrupt', { threadId: 'thread', turnId });
    fail();
    await tick();
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          turn: expect.objectContaining({ id: turnId, status: 'failed', error: expect.objectContaining({ message: 'Native failure' }) }),
        }),
      }),
    );
    await session.close();
  });

  it('retains unknown execution cancellation ownership and rejects a new turn', async () => {
    const { session, backend, output, request } = fixture();
    let nativeSignal!: AbortSignal;
    backend.run = vi.fn(async (_thread, _run, _text, _notify, signal) => {
      nativeSignal = signal;
      throw new ExternalAgentOutcomeUnknownError('No exact terminal receipt');
    });
    await request('initialize');
    await request('thread/start');
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'test' }] });
    await tick();
    expect(nativeSignal.aborted).toBe(false);
    expect(output).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          turn: expect.objectContaining({
            status: 'failed',
            error: expect.objectContaining({ message: 'EXECUTION_UNKNOWN: No exact terminal receipt' }),
          }),
        }),
      }),
    );
    await request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'retry' }] });
    expect(output.at(-1)).toHaveProperty('error');
    expect(backend.run).toHaveBeenCalledTimes(1);
    await session.close(new ExternalAgentStreamError('Output closed'));
    expect(nativeSignal.reason).toBeInstanceOf(ExternalAgentStreamError);
  });

  it('rejects foreign threads and unsupported inputs while allowing independent thread starts', async () => {
    const { backend, output, request } = fixture();
    await request('turn/start');
    expect(output.at(-1)).toHaveProperty('error');
    await request('initialize');
    await request('thread/start');
    await request('thread/start');
    expect(output.at(-1)).toHaveProperty('result.thread.id', 'thread-2');
    await request('turn/start', { threadId: 'foreign', input: [{ type: 'text', text: 'test' }] });
    expect(output.at(-1)).toHaveProperty('error');
    await request('turn/start', {
      threadId: 'thread',
      input: [{ type: 'image', url: 'file:///private' }],
    });
    expect(output.at(-1)).toHaveProperty('error');
    expect(backend.run).not.toHaveBeenCalled();
  });

  it('runs different owned threads concurrently and interrupts only the exact selected run', async () => {
    const h = fixture();
    const runs = new Map<string, { signal: AbortSignal; result: ReturnType<typeof deferred<string>> }>();
    h.backend.run = vi.fn(async (thread, _run, _text, _emit, signal) => {
      const result = deferred<string>();
      runs.set(thread.id, { signal, result });
      return result.promise;
    });
    await h.request('initialize');
    await h.request('thread/start');
    await h.request('thread/start');
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'first' }] });
    const firstTurn = (h.output.at(-1)!.result as { turn: { id: string } }).turn.id;
    await h.request('turn/start', { threadId: 'thread-2', input: [{ type: 'text', text: 'second' }] });
    await tick();
    expect(h.backend.run).toHaveBeenCalledTimes(2);
    await h.request('turn/interrupt', { threadId: 'thread-2', turnId: firstTurn });
    expect(h.output.at(-1)).toHaveProperty('error');
    expect([...runs.values()].every(run => !run.signal.aborted)).toBe(true);
    await h.request('turn/interrupt', { threadId: 'thread', turnId: firstTurn });
    expect(runs.get('thread')!.signal.aborted).toBe(true);
    expect(runs.get('thread-2')!.signal.aborted).toBe(false);
    runs.get('thread')!.result.reject(new ExternalAgentCancelledError('Exact native cancellation'));
    runs.get('thread-2')!.result.resolve('Second thread completed');
    await tick();
    const completed = h.output.filter(frame => frame.method === 'turn/completed');
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({ params: expect.objectContaining({ threadId: 'thread', turn: expect.objectContaining({ status: 'interrupted' }) }) }),
      expect.objectContaining({ params: expect.objectContaining({ threadId: 'thread-2', turn: expect.objectContaining({ status: 'completed' }) }) }),
    ]));
    await h.session.close();
  });

  it('rejects an observing connection before turn admission when metadata reports another active owner', async () => {
    const hub = new CodexAppServerEventHub();
    const h = fixture({ hub });
    const observed: Array<Record<string, unknown>> = [];
    const observer = new CodexAppServerSession(h.backend, frame => observed.push(frame as Record<string, unknown>), { hub });
    const result = deferred<string>();
    const describe = h.backend.describe!;
    let running = false;
    h.backend.describe = vi.fn(id => ({ ...describe(id), ...(running ? { status: ExternalSessionStatus.Running } : {}) }));
    h.backend.run = vi.fn(async () => { running = true; return result.promise; });
    await h.request('initialize');
    await initialize(observer);
    await h.request('thread/start');
    await observer.receive({ id: 'observe', method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } });
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'owned work' }] });
    await tick();
    const before = observed.filter(frame => frame.method === 'turn/started' || frame.method === 'thread/status/changed');
    await observer.receive({ id: 'competing-turn', method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'must not admit' }] } });
    expect(observed.at(-1)).toMatchObject({ id: 'competing-turn', error: expect.any(Object) });
    expect(observed.filter(frame => frame.method === 'turn/started' || frame.method === 'thread/status/changed')).toEqual(before);
    expect(h.backend.run).toHaveBeenCalledTimes(1);
    running = false;
    result.resolve('Exact owner success');
    await tick();
    await observer.close();
    await h.session.close();
  });

  it('closes a locally admitted busy turn without overwriting the winning native owner status', async () => {
    const hub = new CodexAppServerEventHub();
    const h = fixture({ hub });
    const observed: Array<Record<string, unknown>> = [];
    const observer = new CodexAppServerSession(h.backend, frame => observed.push(frame as Record<string, unknown>), { hub });
    const result = deferred<string>();
    let ownerSignal!: AbortSignal;
    h.backend.run = vi.fn(async (_thread, _turn, _text, _emit, signal) => {
      if (ownerSignal) throw new ExternalAgentBusyError('The native execution reservation is held.');
      ownerSignal = signal;
      return result.promise;
    });
    await h.request('initialize');
    await initialize(observer);
    await h.request('thread/start');
    await observer.receive({ id: 'observe', method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } });
    // Both RPCs pass the metadata check before either deferred native admission.
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'winning work' }] });
    await observer.receive({ id: 'racing-turn', method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'racing work' }] } });
    const losingTurn = (observed.at(-1)!.result as { turn: { id: string } }).turn.id;
    await tick();
    expect(h.backend.run).toHaveBeenCalledTimes(2);
    expect(ownerSignal.aborted).toBe(false);
    expect(observed).toContainEqual(expect.objectContaining({ method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ id: losingTurn, status: 'failed' }) }) }));
    expect(observed.filter(frame => frame.method === 'thread/status/changed').map(frame => (frame.params as { status: { type: string } }).status.type)).toEqual(['active', 'active']);
    result.resolve('Winning owner success');
    await tick();
    expect(observed.at(-1)).toMatchObject({ method: 'thread/status/changed', params: { status: { type: 'idle' } } });
    await observer.close();
    await h.session.close();
  });

  it('keeps unknown ownership through repeated resume and permits work on another thread', async () => {
    const h = fixture();
    let unknownSignal!: AbortSignal;
    h.backend.run = vi.fn(async (thread, _run, _text, _emit, signal) => {
      if (thread.id === 'thread') {
        unknownSignal = signal;
        throw new ExternalAgentOutcomeUnknownError('Exact outcome is unavailable');
      }
      return 'Independent success';
    });
    await h.request('initialize');
    await h.request('thread/start');
    await h.request('thread/start');
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'uncertain' }] });
    await tick();
    const unknownTurn = (h.output.find(frame => frame.method === 'turn/started')!.params as { turnId: string }).turnId;
    await h.request('thread/unsubscribe', { threadId: 'thread' });
    expect(unknownSignal.aborted).toBe(false);
    expect(h.session.ownedThreadIds()).toContain('thread');
    await h.request('thread/resume', { threadId: 'thread', excludeTurns: true });
    expect(h.output.at(-1)).toHaveProperty('result.thread.status.type', 'systemError');
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'must not retry' }] });
    expect(h.output.at(-1)).toHaveProperty('error');
    await h.request('turn/start', { threadId: 'thread-2', input: [{ type: 'text', text: 'independent' }] });
    await tick();
    expect(h.backend.run).toHaveBeenCalledTimes(2);
    await h.request('turn/interrupt', { threadId: 'thread', turnId: unknownTurn });
    expect(unknownSignal.aborted).toBe(true);
    await h.session.close();
  });

  it('bounds concurrent metadata openings and fences all late results after close', async () => {
    const h = fixture();
    const pending: Array<ReturnType<typeof deferred<{ id: string; cwd: string; agentId: string }>>> = [];
    h.backend.start = vi.fn(() => {
      const result = deferred<{ id: string; cwd: string; agentId: string }>();
      pending.push(result);
      return result.promise;
    });
    await h.request('initialize');
    const openings = Array.from({ length: 32 }, (_, index) => h.session.receive({ id: `open-${index}`, method: 'thread/start', params: {} }));
    await h.session.receive({ id: 'too-many', method: 'thread/start', params: {} });
    expect(h.output.at(-1)).toMatchObject({ id: 'too-many', error: { code: -32602 } });
    expect(h.backend.start).toHaveBeenCalledTimes(32);
    const beforeClose = [...h.output];
    await h.session.close();
    for (const result of pending) result.resolve({ id: 'thread', cwd: '/task', agentId: 'main' });
    await Promise.all(openings);
    expect(h.output).toEqual(beforeClose);
    expect(h.session.ownedThreadIds()).toEqual([]);
    expect(h.backend.run).not.toHaveBeenCalled();
  });

  it('unsubscribes observation without cancelling a run and resumes the same owner', async () => {
    const h = fixture();
    const result = deferred<string>();
    let emit!: Parameters<CodexAppServerBackend['run']>[3];
    let signal!: AbortSignal;
    h.backend.run = vi.fn(async (_thread, _run, _text, notify, nativeSignal) => {
      emit = notify;
      signal = nativeSignal;
      return result.promise;
    });
    await h.request('initialize');
    await h.request('thread/start');
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'work' }] });
    const turnId = (h.output.at(-1)!.result as { turn: { id: string } }).turn.id;
    await tick();
    await h.request('thread/unsubscribe', { threadId: 'thread' });
    expect(h.output.at(-1)).toHaveProperty('result.status', 'unsubscribed');
    const afterUnsubscribe = [...h.output];
    emit(event({ text: 'Hidden while unsubscribed' }, 'assistant'));
    expect(h.output).toEqual(afterUnsubscribe);
    expect(signal.aborted).toBe(false);
    await h.request('thread/resume', { threadId: 'thread', excludeTurns: true });
    expect(h.output.at(-1)).toHaveProperty('result.thread.status.type', 'active');
    await h.request('turn/interrupt', { threadId: 'thread', turnId });
    expect(signal.aborted).toBe(true);
    result.reject(new ExternalAgentCancelledError('Exact cancellation'));
    await tick();
    expect(h.backend.run).toHaveBeenCalledOnce();
    await h.request('thread/unsubscribe', { threadId: 'thread' });
    expect(h.session.ownedThreadIds()).toEqual([]);
    await h.request('thread/unsubscribe', { threadId: 'thread' });
    expect(h.output.at(-1)).toHaveProperty('result.status', 'notLoaded');
    await h.session.close();
  });

  it('fences deferred unload notifications when a thread is immediately resumed', async () => {
    const h = fixture();
    await h.request('initialize');
    await h.request('thread/start');
    await tick();
    await h.request('thread/unsubscribe', { threadId: 'thread' });
    await h.request('thread/resume', { threadId: 'thread', excludeTurns: true });
    const resumed = h.output.length;
    await tick();
    expect(h.output.slice(resumed).some(frame => frame.method === 'thread/closed')).toBe(false);
    expect(h.output.slice(resumed).some(frame => (frame.params as { status?: { type: string } })?.status?.type === 'notLoaded')).toBe(false);
    expect(h.session.ownedThreadIds()).toEqual(['thread']);
    await h.session.close();
  });

  it('keeps per-turn model selection scoped to its thread and passes it to the native backend', async () => {
    const h = fixture();
    h.backend.models = () => [
      { id: 'provider/model', name: 'Default', isDefault: true },
      { id: 'other/model', name: 'Other', isDefault: false },
    ];
    await h.request('initialize');
    await h.request('thread/start');
    await h.request('thread/start');
    await h.request('turn/start', { threadId: 'thread', model: 'other/model', input: [{ type: 'text', text: 'use other' }] });
    await tick();
    expect(vi.mocked(h.backend.run).mock.calls[0][0]).toMatchObject({ id: 'thread', modelRef: 'other/model' });
    await h.request('thread/read', { threadId: 'thread' });
    expect(h.output.at(-1)).toHaveProperty('result.thread.model', 'other/model');
    await h.request('thread/read', { threadId: 'thread-2' });
    expect(h.output.at(-1)).toHaveProperty('result.thread.model', 'provider/model');
    await h.request('turn/start', { threadId: 'thread', model: 'unavailable/model', input: [{ type: 'text', text: 'reject' }] });
    expect(h.output.at(-1)).toHaveProperty('error.code', -32602);
    expect(h.backend.run).toHaveBeenCalledOnce();
    await h.session.close();
  });

  it('replays authenticated native history by default and routes paginated history without executing', async () => {
    const h = fixture();
    h.backend.history = vi.fn(async id => ({
      threadId: id,
      messages: [
        { role: 'user', content: 'Stored request', __openclaw: { id: 'user', runId: 'native-run' } },
        { role: 'assistant', content: 'Stored answer', phase: 'final_answer', __openclaw: { id: 'answer', runId: 'native-run' } },
      ],
      runs: [{ id: 'private-receipt', sessionId: 'private-product', clientTurnId: 'stored-turn', rootRunId: 'native-run', state: 'completed' as const, startedAt: 1000, endedAt: 2000 }],
    }));
    await h.request('initialize');
    await h.session.receive({ id: 'default-resume', method: 'thread/resume', params: { threadId: 'thread' } });
    expect(h.output.at(-1)).toMatchObject({ result: { thread: { turns: [{ id: 'stored-turn', status: 'completed', items: [expect.objectContaining({ type: 'userMessage' }), expect.objectContaining({ text: 'Stored answer' })] }] } } });
    await h.request('thread/read', { threadId: 'thread', includeTurns: true });
    expect(h.output.at(-1)).toHaveProperty('result.thread.turns.0.id', 'stored-turn');
    await h.request('thread/turns/list', { threadId: 'thread', itemsView: 'full', limit: 1 });
    expect(h.output.at(-1)).toMatchObject({ result: { data: [{ id: 'stored-turn', itemsView: 'full' }] } });
    await h.request('thread/items/list', { threadId: 'thread', turnId: 'stored-turn' });
    expect(h.output.at(-1)).toMatchObject({ result: { data: [{ turnId: 'stored-turn' }, { turnId: 'stored-turn' }] } });
    expect(h.backend.run).not.toHaveBeenCalled();
    expect(h.backend.start).not.toHaveBeenCalled();
    expect(JSON.stringify(h.output)).not.toMatch(/private-receipt|private-product/);
    await h.session.close();
  });

  it('does not install a late resumed binding when native history finishes after close', async () => {
    const h = fixture();
    const history = deferred<ExternalAgentThreadHistory>();
    h.backend.history = vi.fn(() => history.promise);
    await h.request('initialize');
    const opening = h.session.receive({ id: 'resume', method: 'thread/resume', params: { threadId: 'thread' } });
    await Promise.resolve();
    const beforeClose = [...h.output];
    await h.session.close();
    history.resolve({ threadId: 'thread', messages: [], runs: [] });
    await opening;
    expect(h.output).toEqual(beforeClose);
    expect(h.session.ownedThreadIds()).toEqual([]);
  });

  it('isolates a failed hub observer from the publisher and other subscribed output', async () => {
    const hub = new CodexAppServerEventHub();
    const h = fixture({ hub });
    const observer = new CodexAppServerSession(h.backend, frame => {
      if ((frame as Record<string, unknown>).method === 'item/started') throw new Error('Observer output failed');
    }, { hub });
    const result = deferred<string>();
    let nativeSignal!: AbortSignal;
    h.backend.run = vi.fn(async (_thread, _run, _text, emit, signal) => {
      nativeSignal = signal;
      emit(event({ text: 'Observed output' }, 'assistant'));
      return result.promise;
    });
    await h.request('initialize');
    await initialize(observer);
    await h.request('thread/start');
    await observer.receive({ id: 'observe', method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } });
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'work' }] });
    await tick();
    expect(nativeSignal.aborted).toBe(false);
    expect(observer.ownedThreadIds()).toEqual([]);
    result.resolve('Exact success');
    await tick();
    expect(h.output).toContainEqual(expect.objectContaining({ method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ status: 'completed' }) }) }));
    await h.session.close();
    await observer.close();
  });

  it('publishes settled cancellation to remaining observers after the exact owner closes', async () => {
    const hub = new CodexAppServerEventHub();
    const h = fixture({ hub });
    const observed: Array<Record<string, unknown>> = [];
    const observer = new CodexAppServerSession(h.backend, frame => observed.push(frame as Record<string, unknown>), { hub });
    const result = deferred<string>();
    let emit!: Parameters<CodexAppServerBackend['run']>[3];
    let nativeSignal!: AbortSignal;
    h.backend.run = vi.fn(async (_thread, _run, _text, notify, signal) => {
      emit = notify;
      nativeSignal = signal;
      return result.promise;
    });
    await h.request('initialize');
    await initialize(observer);
    await h.request('thread/start');
    await observer.receive({ id: 'observe', method: 'thread/resume', params: { threadId: 'thread', excludeTurns: true } });
    await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'work' }] });
    await tick();
    const ownerOutput = [...h.output];
    const closing = h.session.close();
    await Promise.resolve();
    expect(nativeSignal.aborted).toBe(true);
    emit(event({ text: 'Do not forward after owner withdrawal' }, 'assistant'));
    result.reject(new ExternalAgentCancelledError('Exact native cancellation'));
    await closing;
    expect(h.output).toEqual(ownerOutput);
    expect(JSON.stringify(observed)).not.toContain('Do not forward');
    expect(observed).toContainEqual(expect.objectContaining({ method: 'turn/completed', params: expect.objectContaining({ turn: expect.objectContaining({ status: 'interrupted' }) }) }));
    await observer.close();
  });

  it('broadcasts a persisted name update once to each subscriber and its unbound requester', async () => {
    const hub = new CodexAppServerEventHub();
    const h = fixture({ hub });
    const response: Array<Record<string, unknown>> = [];
    const requester = new CodexAppServerSession(h.backend, frame => response.push(frame as Record<string, unknown>), { hub });
    await h.request('initialize');
    await initialize(requester);
    await h.request('thread/start');
    await tick();
    await requester.receive({ id: 'rename', method: 'thread/name/set', params: { threadId: 'thread', name: 'New name' } });
    await tick();
    expect(h.output.filter(frame => frame.method === 'thread/name/updated')).toHaveLength(1);
    expect(response.filter(frame => frame.method === 'thread/name/updated')).toHaveLength(1);
    await h.request('thread/name/set', { threadId: 'thread', name: 'Changed by subscriber' });
    await tick();
    expect(h.output.filter(frame => frame.method === 'thread/name/updated')).toHaveLength(2);
    await requester.close();
    await h.session.close();
  });

  it('prepares exact native approval resources and keeps them reusable after idle unsubscribe', async () => {
    const prepare = vi.fn<ExternalClientResources['prepare']>(async () => () => {});
    const close = vi.fn<ExternalClientResources['close']>(async () => {});
    const h = fixture({ resources: { prepare, close } });
    const release = vi.fn();
    h.backend.run = vi.fn(async (thread, runId, _text, _emit, signal, hooks) => {
      expect(hooks?.interactiveApprovals).toBe(true);
      const cleanup = await hooks!.onPrepared!({
        localSessionId: 'private-product', runId, sessionKey: 'private-native-key',
        sessionId: 'private-native-id', lifecycleRevision: 'private-revision',
        client: {} as Parameters<ExternalClientResources['prepare']>[2]['client'],
      });
      expect(prepare.mock.calls.at(-1)?.[0].id).toBe(thread.id);
      expect(prepare.mock.calls.at(-1)?.[1]).toEqual([]);
      expect(prepare.mock.calls.at(-1)?.[4]).toBe(signal);
      const present = prepare.mock.calls.at(-1)![3];
      const decision = await present({
        kind: ApprovalKind.Exec, id: `approval-${runId}`, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        request: { runId, sessionKey: 'private-native-key', sessionId: 'private-native-id', toolCallId: 'call', command: 'fixture-command', allowedDecisions: ['allow-once', 'deny'] },
      }, new AbortController().signal);
      expect(decision).toBe('allow-once');
      if (cleanup) await cleanup();
      return 'Approved exact call';
    });
    prepare.mockImplementation(async () => release);
    await h.request('initialize');
    await h.request('thread/start');
    expect(h.output.at(-1)).toHaveProperty('result.approvalPolicy', 'on-request');
    for (let index = 0; index < 2; index++) {
      await h.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'approval required' }] });
      await tick();
      const prompt = h.output.findLast(frame => frame.method === 'item/commandExecution/requestApproval')!;
      expect(prompt).toMatchObject({ id: expect.any(String), params: { threadId: 'thread', turnId: expect.any(String) } });
      expect(JSON.stringify(prompt)).not.toMatch(/private-native-key|private-native-id|private-product|private-revision/);
      await h.session.receive({ id: prompt.id, result: { decision: 'accept' } });
      await tick();
      await h.request('thread/unsubscribe', { threadId: 'thread' });
      expect(close).not.toHaveBeenCalled();
      if (index === 0) await h.request('thread/resume', { threadId: 'thread', excludeTurns: true });
    }
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    await h.session.close();
    expect(close).toHaveBeenCalledExactlyOnceWith('thread');
  });
});
