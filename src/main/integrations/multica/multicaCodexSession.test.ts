import { describe, expect, it, vi } from 'vitest';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import { type MulticaCodexBackend, MulticaCodexSession } from './multicaCodexSession';

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
  const backend: MulticaCodexBackend = {
    models: () => [{ id: 'provider/model', name: 'Configured model', isDefault: true }],
    start: vi.fn(async () => thread),
    resume: vi.fn(async () => thread),
    run: vi.fn(async () => 'done'),
  };
  const session = new MulticaCodexSession(backend, value =>
    output.push(value as Record<string, unknown>),
  );
  const request = (method: string, params = {}) =>
    session.receive({ id: output.length + 1, method, params });
  return { session, backend, output, request };
}

describe('Multica Codex session', () => {
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

  it('accepts Multica null placeholders and reports the configured default model independent of ordering', async () => {
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

  it('routes cancellation to the active run and never claims completion before it settles', async () => {
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
          turn: { id: turnId, status: 'interrupted' },
        }),
      }),
    );
    expect(output.some(value => value.method === 'item/completed')).toBe(false);
    await session.close();
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
