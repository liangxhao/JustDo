import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { ExternalSessionSource } from '../../../shared/integrations/externalSession';
import { OpenClawProviderId } from '../../../shared/providers/constants';
import { CoworkStore } from '../../data/coworkStore';
import { SqliteStore } from '../../data/sqliteStore';
import {
  ExternalAgentBackendFactory,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentBackend';
import type { ExternalAgentExecution } from './externalAgentTypes';
import { ExternalSessionStore } from './externalSessionStore';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-backend-'));
  const sqlite = SqliteStore.create(cwd);
  cleanup.push(() => {
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const store = new CoworkStore(sqlite.getDatabase());
  const external = new ExternalSessionStore(sqlite.getDatabase());
  const models = [
    { id: 'provider/default', name: 'Default model', isDefault: true },
    { id: 'other/selected', name: 'Selected model', isDefault: false },
  ];
  const execute = vi.fn<ExternalAgentExecution>(async () => 'Answer');
  const onSessionsChanged = vi.fn();
  const options = {
    getCoworkStore: () => store,
    getExternalSessionStore: () => external,
    getModels: () => models,
    execute,
    onSessionsChanged,
  };
  const factory = new ExternalAgentBackendFactory(options);
  return {
    cwd,
    sqlite,
    store,
    external,
    models,
    execute,
    factory,
    options,
    backend: factory.connect(),
  };
}

it('uses per-session directories and opaque IDs without client credentials or rollout markers', async () => {
  const f = fixture();
  const other = path.join(f.cwd, '另一个 项目');
  fs.mkdirSync(other);
  const first = await f.backend.start({ cwd: f.cwd });
  const second = await f.backend.start({ cwd: other, model: 'other/selected' });
  expect(first.id).not.toBe(second.id);
  expect(second.cwd).toBe(fs.realpathSync(other));
  expect(f.store.listSessions().every(session => session.external?.origin === 'cli')).toBe(true);
  expect(fs.existsSync(path.join(f.cwd, 'sessions'))).toBe(false);
  await expect(f.factory.connect().resume(first.id, {})).resolves.toEqual(first);
  await expect(f.backend.resume(first.id, { cwd: other })).rejects.toThrow('directory');
  await expect(f.backend.resume('agent:main:native-key', {})).rejects.toThrow('identity');
  expect(second.modelRef).toBe('other/selected');
});

it('retains a selected assistant and confirmed model route while rejecting unavailable identities', async () => {
  const f = fixture();
  const agent = f.store.saveAgentProfile({
    id: 'reviewer',
    name: 'Reviewer',
    description: '',
    icon: '',
    model: '',
    enabled: true,
    isDefault: false,
  });
  const route = `${OpenClawProviderId.BuiltinModels}/openai/internal`;
  f.models.push({ id: route, name: 'Built-in', isDefault: false });
  const thread = await f.backend.start({ cwd: f.cwd, agentId: agent.id, model: route });
  expect(thread.agentId).toBe(agent.id);
  f.store.updateSession(f.store.listSessions()[0].id, { modelRef: 'openai/internal' });
  await expect(f.backend.resume(thread.id, {})).resolves.toMatchObject({ modelRef: route });
  await expect(f.backend.resume(thread.id, { model: 'openai/internal' })).rejects.toThrow(
    'model is unavailable',
  );
  f.store.updateAgent(agent.id, { enabled: false });
  await expect(f.backend.resume(thread.id, {})).rejects.toThrow('assistant is unavailable');
  await expect(f.backend.start({ cwd: f.cwd, agentId: 'missing' })).rejects.toThrow(
    'assistant is unavailable',
  );
});

it('never recreates a deleted conversation or its tombstoned mapping', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  f.store.deleteSession(f.store.listSessions()[0].id);
  await expect(f.backend.resume(thread.id, {})).rejects.toThrow('unavailable');
  expect(f.external.wasDeleted(thread.id)).toBe(true);
  expect(f.store.listSessions()).toHaveLength(0);
});

it('rolls back only a newly created empty session when local metadata setup fails', async () => {
  const f = fixture();
  let id = '';
  await expect(
    f.backend.start({
      cwd: f.cwd,
      onCreated: thread => {
        id = thread.id;
        throw new Error('Marker unavailable');
      },
    }),
  ).rejects.toThrow('Marker unavailable');
  expect(f.store.listSessions()).toHaveLength(0);
  expect(f.external.get(id)).toBeNull();
  expect(f.external.wasDeleted(id)).toBe(true);
  await expect(f.backend.resume(id, {})).rejects.toThrow('unavailable');
  expect(f.execute).not.toHaveBeenCalled();
});

it('never guesses a historical scoped mapping from its bare thread UUID', async () => {
  const f = fixture();
  const id = randomUUID();
  const session = f.store.createSession('Historical client', f.cwd);
  const historical = new ExternalSessionStore(
    f.sqlite.getDatabase(),
    ExternalSessionSource.HistoricalAppServer,
  );
  const key = `codex:${'a'.repeat(32)}:${id}`;
  historical.create({
    externalSessionKey: key,
    coworkSessionId: session.id,
    agentId: session.agentId,
    openclawSessionKey: 'original-native-key',
    cwd: f.cwd,
  });
  await expect(f.backend.resume(id, {})).rejects.toThrow('unavailable');
  await expect(f.backend.resume(key, {})).rejects.toThrow('identity');
  expect(historical.get(key)).toMatchObject({
    coworkSessionId: session.id,
    openclawSessionKey: 'original-native-key',
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it('holds a shared reservation through cancellation until native settlement', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  let finish!: (text: string) => void;
  f.execute.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const running = f.backend.run(thread, randomUUID(), 'Task', () => {}, controller.signal);
  controller.abort();
  const other = new ExternalAgentBackendFactory(f.options);
  await expect(
    other.connect().run(thread, randomUUID(), 'Other task', () => {}, new AbortController().signal),
  ).rejects.toThrow('active or unconfirmed');
  expect(f.factory.activeTaskCount).toBe(1);
  finish('Done');
  await running;
  expect(f.factory.activeTaskCount).toBe(0);
  expect(f.external.get(thread.id)?.status).toBe('completed');
});

it('persists the exact binding before caller tool hooks and leaves unknown work reserved across factories', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const runId = randomUUID();
  const onPrepared = vi.fn(async () => {
    expect(f.external.get(thread.id)).toMatchObject({
      executionRunId: runId,
      nativeSessionId: 'native-id',
      lifecycleRevision: 'revision-1',
      executionState: 'running',
    });
  });
  f.execute.mockImplementation(async input => {
    await input.hooks?.onPrepared?.({
      localSessionId: input.sessionId,
      runId: input.runId,
      sessionKey: 'native-key',
      sessionId: 'native-id',
      lifecycleRevision: 'revision-1',
      client: {} as never,
    });
    throw new ExternalAgentOutcomeUnknownError('The native outcome is unknown.');
  });
  await expect(
    f.backend.run(thread, runId, 'Task', () => {}, new AbortController().signal, { onPrepared }),
  ).rejects.toThrow('outcome is unknown');
  expect(onPrepared).toHaveBeenCalledTimes(1);
  expect(f.factory.activeTaskCount).toBe(1);
  expect(f.external.get(thread.id)).toMatchObject({
    status: 'running',
    executionState: 'unknown',
    executionRunId: runId,
  });
  const restarted = new ExternalAgentBackendFactory(f.options);
  expect(restarted.activeTaskCount).toBe(1);
  await expect(
    restarted.connect().run(thread, randomUUID(), 'Retry', () => {}, new AbortController().signal),
  ).rejects.toThrow('unconfirmed');
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('preserves native success on output failure and rejects obsolete models before dispatch', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd, model: 'other/selected' });
  const controller = new AbortController();
  f.execute.mockImplementation(async () => {
    controller.abort(new ExternalAgentStreamError('Output limit'));
    return 'Done';
  });
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, controller.signal),
  ).rejects.toThrow('Output limit');
  expect(f.external.get(thread.id)?.status).toBe('completed');
  f.models.pop();
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, new AbortController().signal),
  ).rejects.toThrow('model is unavailable');
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('does not replay a completed native request under a previously used execution identity', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const runId = randomUUID();
  await f.backend.run(thread, runId, 'First task', () => {}, new AbortController().signal);
  await expect(
    f.backend.run(thread, runId, 'Replay', () => {}, new AbortController().signal),
  ).rejects.toThrow('already been used');
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('preserves native cancellation even when no local client requested a stop', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  f.execute.mockRejectedValue(new ExternalAgentCancelledError('Native execution was cancelled.'));
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(ExternalAgentCancelledError);
  expect(f.external.get(thread.id)?.status).toBe('cancelled');
});

it('does not overwrite exact native failure when a local stop was also requested', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const controller = new AbortController();
  f.execute.mockImplementation(async input => {
    input.onSettled?.('failed');
    controller.abort();
    throw new Error('Native failure');
  });
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, controller.signal),
  ).rejects.toThrow('Native failure');
  expect(f.external.get(thread.id)?.status).toBe('error');
});
