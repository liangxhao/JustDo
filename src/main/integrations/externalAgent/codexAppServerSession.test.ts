import { describe, expect, it, vi } from 'vitest';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import { type CodexAppServerBackend, CodexAppServerSession } from './codexAppServerSession';
import {
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentTypes';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
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
function fixture() {
  const output: Array<Record<string, unknown>> = [];
  const thread = { id: 'thread', cwd: '/task', agentId: 'main', modelRef: 'provider/model' };
  const backend: CodexAppServerBackend = {
    models: () => [{ id: 'provider/model', name: 'Configured model', isDefault: true }],
    start: vi.fn(async () => thread),
    resume: vi.fn(async () => thread),
    run: vi.fn(async () => 'done'),
  };
  const session = new CodexAppServerSession(backend, value =>
    output.push(value as Record<string, unknown>),
  );
  const request = (method: string, params = {}) =>
    session.receive({ id: output.length + 1, method, params });
  return { session, backend, output, request };
}

describe('Codex app-server session', () => {
  it('keeps console initialization optional notifications from dispatching work', async () => {
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
    expect(output.at(-1)).toMatchObject({
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
    expect(output.at(-1)).toMatchObject({ method: 'turn/completed' });
    await session.close();
  });

  it('keeps thread operations bound to their CLI ownership when the shared router extracts them', async () => {
    const { session, backend, output, request } = fixture();
    await request('initialize');
    await request('thread/resume', { threadId: 'saved-thread', cwd: null, model: null });

    expect(backend.resume).toHaveBeenCalledExactlyOnceWith('saved-thread', {
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
    expect(backend.start).not.toHaveBeenCalled();
    await session.close();
  });

  it('reserves its single thread while asynchronous creation is still opening', async () => {
    const { session, backend, output, request } = fixture();
    const thread = { id: 'thread', cwd: '/task', agentId: 'main' };
    let finish!: (value: typeof thread) => void;
    backend.start = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await request('initialize');
    const opening = session.receive({ id: 'first-open', method: 'thread/start', params: {} });

    await session.receive({ id: 'second-open', method: 'thread/start', params: {} });

    expect(backend.start).toHaveBeenCalledOnce();
    expect(output.at(-1)).toMatchObject({
      id: 'second-open',
      error: { message: 'This connection already owns a thread.' },
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

  it.each(['model', 'cwd', 'approvalPolicy', 'sandboxPolicy', 'outputSchema'])(
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
            error: { message: 'Assistant output exceeded the event limit.' },
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
          turn: { id: turnId, status: 'completed' },
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
            turn: { id: turnId, status: 'interrupted', error: null },
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
          turn: { id: turnId, status: 'failed', error: { message: 'Native failure' } },
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
            error: { message: 'EXECUTION_UNKNOWN: No exact terminal receipt' },
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

  it('rejects foreign threads, duplicate starts and unsupported inputs instead of silently dropping them', async () => {
    const { backend, output, request } = fixture();
    await request('turn/start');
    expect(output.at(-1)).toHaveProperty('error');
    await request('initialize');
    await request('thread/start');
    await request('thread/start');
    expect(output.at(-1)).toHaveProperty('error');
    await request('turn/start', { threadId: 'foreign', input: [{ type: 'text', text: 'test' }] });
    expect(output.at(-1)).toHaveProperty('error');
    await request('turn/start', {
      threadId: 'thread',
      input: [{ type: 'image', url: 'file:///private' }],
    });
    expect(output.at(-1)).toHaveProperty('error');
    expect(backend.run).not.toHaveBeenCalled();
  });
});
