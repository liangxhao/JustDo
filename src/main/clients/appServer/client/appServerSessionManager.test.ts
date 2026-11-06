import { randomUUID } from 'node:crypto';

import { expect, test, vi } from 'vitest';

import { AgentCommandService } from '../../cli/agentCommandService';
import { type ExternalAgentBackend, type ExternalAgentBackendFactory, ExternalAgentCancelledError } from '../../shared/externalAgentBackend';
import { AppServerSessionManager } from './appServerSessionManager';

function setup(overrides: Partial<ExternalAgentBackend> = {}) {
  const thread = { id: randomUUID(), cwd: process.cwd(), agentId: 'main', modelRef: 'provider/model' };
  const backend: ExternalAgentBackend = {
    models: vi.fn(() => [{ id: 'provider/model', name: 'Model', isDefault: true }]),
    start: vi.fn(async () => thread),
    resume: vi.fn(async () => thread),
    describe: vi.fn(id => ({ ...thread, id, name: 'Fixture', createdAt: 1000, updatedAt: 2000,
      permissionMode: 'full' as const, status: 'completed' as const })),
    run: vi.fn(async () => 'answer'),
    ...overrides,
  };
  const connect = vi.fn(() => backend);
  const factory = { connect, models: backend.models, activeTaskCount: 0 } as unknown as ExternalAgentBackendFactory;
  const createResources = vi.fn(() => ({ prepare: async () => () => {}, close: async () => {} }));
  const manager = new AppServerSessionManager({ backend: factory, createResources });
  const service = new AgentCommandService({
    backend: factory,
    createResources,
    appServerSessions: manager,
    getStatus: () => ({
      supported: true,
      command: 'agent',
      launcherReady: true,
      bridgeRunning: true,
      activeTaskCount: 0,
      gatewayPhase: 'stopped',
    }),
  });
  return { service, manager, backend, connect, thread, createResources };
}

test('profile shutdown waits for an existing close drain and closes the other peers', async () => {
  let release!: () => void;
  const terminal = new Promise<void>(resolve => { release = resolve; });
  let nativeSignal: AbortSignal | undefined;
  const h = setup({ run: async (_thread, _id, _message, _event, signal) => {
    nativeSignal = signal;
    await terminal;
    throw new ExternalAgentCancelledError('Exact native cancellation.');
  } });
  const output: Array<Record<string, unknown>> = [];
  const owner = h.service.connect(process.cwd(), {}, value => output.push(value as Record<string, unknown>));
  const observer = h.manager.connect(process.cwd(), {}, () => {});
  for (const peer of [owner, observer]) {
    await peer.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'peer', version: '1' } } });
    await peer.receive({ method: 'initialized' });
    await peer.receive({ id: 2, method: 'thread/resume', params: { threadId: h.thread.id, excludeTurns: true } });
  }
  await owner.receive({ id: 3, method: 'turn/start', params: { threadId: h.thread.id, input: [{ type: 'text', text: 'work' }] } });
  await vi.waitFor(() => expect(nativeSignal).toBeDefined());
  const closing = owner.close();
  const closingAgain = owner.close();
  let stopped = false;
  const stopping = h.manager.stop().then(() => { stopped = true; });
  try {
    expect(h.manager.loadedThreadIds()).toEqual([]);
    await vi.waitFor(() => expect(nativeSignal!.aborted).toBe(true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    const previousOutput = output.length;
    release();
    await Promise.all([closing, closingAgain, stopping]);
    expect(stopped).toBe(true);
    expect(output).toHaveLength(previousOutput);
  } finally {
    release();
    await Promise.allSettled([closing, closingAgain, stopping, observer.close()]);
  }
});

test('stdio and native peers share loaded threads and retire only their own connection', async () => {
  const h = setup();
  h.backend.start = vi.fn(async () => ({ ...h.thread, id: randomUUID() }));
  const connect = async (stdio = false) => {
    const output: Array<Record<string, unknown>> = [];
    const send = (value: unknown) => output.push(value as Record<string, unknown>);
    const peer = stdio ? h.service.connect(process.cwd(), {}, send) : h.manager.connect(process.cwd(), {}, send);
    await peer.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'client', version: '1' } } });
    await peer.receive({ method: 'initialized' });
    return { peer, output };
  };
  const first = await connect(true);
  const second = await connect();
  const observer = await connect();
  await first.peer.receive({ id: 2, method: 'thread/start', params: {} });
  await second.peer.receive({ id: 2, method: 'thread/start', params: {} });
  const id = (entry: typeof first) => (entry.output.at(-1)!.result as { thread: { id: string } }).thread.id;
  const firstId = id(first);
  const secondId = id(second);
  await observer.peer.receive({ id: 2, method: 'thread/loaded/list', params: {} });
  expect(observer.output.at(-1)).toMatchObject({ result: { data: [firstId, secondId].sort(), nextCursor: null } });
  await first.peer.close();
  await observer.peer.receive({ id: 3, method: 'thread/loaded/list', params: {} });
  expect(observer.output.at(-1)).toMatchObject({ result: { data: [secondId] } });
  await second.peer.close();
  await observer.peer.close();
  expect(h.createResources).toHaveBeenCalledTimes(3);
  expect(h.manager.loadedThreadIds()).toEqual([]);
});

test('stdio and native peers share events while only the admitting peer can interrupt its turn', async () => {
  let finish!: (text: string) => void;
  const h = setup({ run: () => new Promise<string>(resolve => { finish = resolve; }) });
  const connect = async (stdio = false) => {
    const output: Array<Record<string, unknown>> = [];
    const send = (value: unknown) => output.push(value as Record<string, unknown>);
    const peer = stdio ? h.service.connect(process.cwd(), {}, send) : h.manager.connect(process.cwd(), {}, send);
    await peer.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'peer', version: '1' } } });
    await peer.receive({ method: 'initialized' });
    return { peer, output };
  };
  const owner = await connect(true);
  const observer = await connect();
  try {
    await owner.peer.receive({ id: 2, method: 'thread/start', params: {} });
    await observer.peer.receive({ id: 2, method: 'thread/resume', params: { threadId: h.thread.id, excludeTurns: true } });
    await owner.peer.receive({ id: 3, method: 'turn/start', params: { threadId: h.thread.id, input: [{ type: 'text', text: 'work' }] } });
    await vi.waitFor(() => expect(observer.output.some(value => value.method === 'turn/started')).toBe(true));
    const started = owner.output.find(value => value.id === 3)!.result as { turn: { id: string } };
    await observer.peer.receive({ id: 3, method: 'turn/interrupt', params: { threadId: h.thread.id, turnId: started.turn.id } });
    expect(observer.output.find(value => value.id === 3)).toHaveProperty('error');
    finish('shared result');
    await vi.waitFor(() => expect(observer.output.some(value => value.method === 'turn/completed')).toBe(true));
    for (const client of [owner, observer]) {
      expect(client.output.filter(value => value.method === 'turn/completed')).toHaveLength(1);
      expect(client.output).toContainEqual(expect.objectContaining({ method: 'item/agentMessage/delta', params: expect.objectContaining({ delta: 'shared result' }) }));
    }
  } finally {
    finish?.('cleanup');
    await Promise.all([owner.peer.close(), observer.peer.close()]);
  }
});
