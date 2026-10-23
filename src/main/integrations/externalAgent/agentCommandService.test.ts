import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { AgentCliExitCode } from '../../../shared/integrations/agentCli';
import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import { AgentCommandService } from './agentCommandService';
import {
  type ExternalAgentBackend,
  type ExternalAgentBackendFactory,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentBackend';

function setup(overrides: Partial<ExternalAgentBackend> = {}) {
  const thread = { id: randomUUID(), cwd: process.cwd(), agentId: 'main' };
  const backend: ExternalAgentBackend = {
    models: vi.fn(() => [{ id: 'provider/model', name: 'Model', isDefault: true }]),
    start: vi.fn(async () => thread),
    resume: vi.fn(async () => thread),
    run: vi.fn(async () => 'answer'),
    ...overrides,
  };
  const connect = vi.fn(() => backend);
  const service = new AgentCommandService({
    backend: {
      connect,
      models: backend.models,
      activeTaskCount: 0,
    } as unknown as ExternalAgentBackendFactory,
    createResources: () => ({ prepare: async () => () => {}, close: async () => {} }),
    getStatus: () => ({
      supported: true,
      command: 'agent',
      launcherReady: true,
      bridgeRunning: true,
      activeTaskCount: 0,
      gatewayPhase: 'stopped',
    }),
  });
  return { service, backend, connect, thread };
}

test('help and status read the always available entry without connecting to execution', async () => {
  const h = setup();
  expect((await h.service.execute(['--help'])).exitCode).toBe(0);
  const result = await h.service.execute(['status', '--json']);
  expect(JSON.parse(result.stdout!)).toMatchObject({ gatewayPhase: 'stopped' });
  expect(h.connect).not.toHaveBeenCalled();
});

test('CLI and Codex discovery share one configured model catalog', async () => {
  const h = setup();
  const result = await h.service.execute(['models', 'list', '--json']);
  expect(JSON.parse(result.stdout!)).toEqual({
    models: [{ id: 'provider/model', name: 'Model', isDefault: true }],
  });
  const debug = ['debug', 'models', '--bundled'];
  const discovered = await h.service.execute(debug);
  expect(JSON.parse(discovered.stdout!)).toMatchObject({
    models: [{ slug: 'provider/model', display_name: 'Model' }],
  });
  expect(h.connect).not.toHaveBeenCalled();
});

test('Codex app-server uses the generic backend without client-specific environment', async () => {
  const h = setup();
  const output = vi.fn();
  const session = h.service.connect(process.cwd(), {}, output, [
    'app-server',
    '--listen',
    'stdio://',
  ]);
  await session.receive({ id: 1, method: 'initialize' });
  await session.receive({ id: 2, method: 'thread/start' });
  expect(h.backend.start).toHaveBeenCalledWith({ cwd: process.cwd(), model: undefined });
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 2,
      result: expect.objectContaining({ thread: expect.objectContaining({ id: h.thread.id }) }),
    }),
  );
  await session.close();
  expect(h.connect).toHaveBeenCalledTimes(1);
});

test('resume retains its stored cwd unless the caller explicitly supplies a cwd', async () => {
  const h = setup();
  await h.service.execute(
    ['exec', '--session', h.thread.id, 'continue'],
    path.parse(process.cwd()).root,
  );
  expect(h.backend.resume).toHaveBeenCalledWith(h.thread.id, { model: undefined });
  await h.service.execute(['exec', '--session', h.thread.id, '--cwd', 'project', 'continue']);
  expect(h.backend.resume).toHaveBeenLastCalledWith(h.thread.id, {
    cwd: path.resolve('project'),
    model: undefined,
  });
});

test('streamed events and final results retain the same session and run identities', async () => {
  const h = setup({
    run: async (_thread, _runId, _message, onEvent) => {
      onEvent({ stream: 'assistant', data: { text: 'answer' } } as NormalizedAgentEvent);
      return 'answer';
    },
  });
  const emit = vi.fn();
  const result = await h.service.execute(
    ['exec', '--stream-json', 'work'],
    undefined,
    undefined,
    undefined,
    emit,
  );
  const final = JSON.parse(result.stdout!);
  const event = JSON.parse(emit.mock.calls[0][1]);
  expect(final).toMatchObject({ type: 'result', status: 'completed', text: 'answer' });
  expect(event).toMatchObject({ type: 'event', sessionId: final.sessionId, runId: final.runId });
  expect(result.exitCode).toBe(AgentCliExitCode.Success);
});

test('unknown outcomes expose the admitted identity and retain cancellation until disconnect', async () => {
  let nativeSignal!: AbortSignal;
  const h = setup({
    run: async (_thread, _id, _message, _event, signal) => {
      nativeSignal = signal;
      throw new ExternalAgentOutcomeUnknownError('Exact native terminal is unavailable.');
    },
  });
  const transport = new AbortController();
  const result = await h.service.execute(
    ['exec', '--json', 'work'],
    undefined,
    undefined,
    transport.signal,
  );
  expect(result.exitCode).toBe(AgentCliExitCode.BridgeError);
  expect(JSON.parse(result.stdout!)).toMatchObject({
    type: 'error',
    sessionId: h.thread.id,
    runId: expect.any(String),
    error: { code: 'EXECUTION_UNKNOWN' },
  });
  expect(nativeSignal.aborted).toBe(false);
  transport.abort();
  expect(nativeSignal.aborted).toBe(true);
});

test('an exact native cancellation returns exit 130 even without local cancellation', async () => {
  const h = setup({
    run: async () => {
      throw new ExternalAgentCancelledError('Native execution cancelled.');
    },
  });
  const result = await h.service.execute(['exec', '--json', 'work']);
  expect(result.exitCode).toBe(AgentCliExitCode.Cancelled);
  expect(JSON.parse(result.stdout!)).toMatchObject({ type: 'result', status: 'cancelled' });
});

test('a stop request racing with an exact success keeps the completed outcome', async () => {
  const transport = new AbortController();
  const h = setup({
    run: async () => {
      transport.abort();
      return 'finished';
    },
  });
  const result = await h.service.execute(
    ['exec', '--json', 'work'],
    undefined,
    undefined,
    transport.signal,
  );
  expect(result.exitCode).toBe(AgentCliExitCode.Success);
  expect(JSON.parse(result.stdout!)).toMatchObject({ status: 'completed', text: 'finished' });
});

test('a stop request cannot change an exact native failure into cancellation', async () => {
  const transport = new AbortController();
  const h = setup({
    run: async () => {
      transport.abort();
      throw new Error('Native execution failed.');
    },
  });
  const result = await h.service.execute(
    ['exec', '--json', 'work'],
    undefined,
    undefined,
    transport.signal,
  );
  expect(result.exitCode).toBe(AgentCliExitCode.BridgeError);
  expect(JSON.parse(result.stdout!)).toMatchObject({
    type: 'error',
    error: { message: 'Native execution failed.' },
  });
});

test('an output failure cannot become a cancelled result', async () => {
  const transport = new AbortController();
  const h = setup({
    run: async (_thread, _id, _message, _event, signal) => {
      transport.abort(new ExternalAgentStreamError('Output closed unexpectedly.'));
      throw signal.reason;
    },
  });
  const result = await h.service.execute(
    ['exec', '--json', 'work'],
    undefined,
    undefined,
    transport.signal,
  );
  expect(result.exitCode).toBe(AgentCliExitCode.BridgeError);
  expect(JSON.parse(result.stdout!)).toMatchObject({
    type: 'error',
    error: { message: 'Output closed unexpectedly.' },
  });
});
