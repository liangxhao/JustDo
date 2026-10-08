import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { OpenClawProviderId } from '../../../shared/providers/constants';
import { CoworkStore } from '../../data/coworkStore';
import { SqliteStore } from '../../data/sqliteStore';
import { MulticaCodexBackendFactory } from './multicaCodexBackend';
import { MulticaCodexStreamError } from './multicaCodexSession';
import { MulticaExternalSessionStore } from './multicaExternalSessionStore';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-codex-'));
  const sqlite = SqliteStore.create(cwd);
  cleanup.push(() => {
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const store = new CoworkStore(sqlite.getDatabase());
  const external = new MulticaExternalSessionStore(sqlite.getDatabase());
  const execute = vi.fn(async () => 'answer');
  const models = [
    { id: 'provider/default', name: 'Default model', isDefault: true },
    { id: 'other/selected', name: 'Selected model', isDefault: false },
  ];
  const factory = new MulticaCodexBackendFactory({
    getCoworkStore: () => store,
    getExternalSessionStore: () => external,
    getModels: () => models,
    execute,
    isEnabled: () => true,
    onSessionsChanged: () => {},
  });
  const env = {
    MULTICA_TOKEN: 'mat_test',
    MULTICA_TASK_CONFIG_ROOT: cwd,
    MULTICA_WORKSPACE_ID: 'workspace',
    MULTICA_AGENT_ID: 'external-agent',
    MULTICA_TASK_ID: 'task',
    MULTICA_SERVER_URL: 'https://example.invalid',
    CODEX_HOME: cwd,
  };
  return {
    cwd,
    store,
    external,
    execute,
    factory,
    models,
    env,
    backend: factory.connect(cwd, env),
  };
}

it('resumes across connections using identity metadata without storing transcripts', async () => {
  const { backend, factory, cwd, env, store } = fixture();
  const thread = await backend.start({});
  await expect(
    factory.connect(cwd, { ...env, MULTICA_TASK_ID: 'next' }).resume(thread.id, {}),
  ).resolves.toEqual(thread);
  const marker = fs.readFileSync(
    path.join(cwd, 'sessions', `rollout-justdo-${thread.id}.jsonl`),
    'utf8',
  );
  expect(JSON.parse(marker)).toEqual({
    type: 'session_meta',
    payload: { id: thread.id, originator: 'justdo', cwd: thread.cwd },
  });
  expect(store.listSessions()).toHaveLength(1);
});

it('rejects foreign ownership, changed directories and deleted conversations', async () => {
  const { backend, factory, cwd, env, store } = fixture();
  const thread = await backend.start({});
  await expect(
    factory.connect(cwd, { ...env, MULTICA_AGENT_ID: 'foreign' }).resume(thread.id, {}),
  ).rejects.toThrow('unavailable');
  const other = path.join(cwd, 'other');
  fs.mkdirSync(other);
  await expect(factory.connect(other, env).resume(thread.id, {})).rejects.toThrow('directory');
  store.deleteSession(store.listSessions()[0].id);
  await expect(backend.resume(thread.id, {})).rejects.toThrow('unavailable');
});

it('holds the shared conversation reservation until cancelled execution actually settles', async () => {
  const { backend, factory, cwd, env, execute } = fixture();
  const thread = await backend.start({});
  let finish!: (text: string) => void;
  execute.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const running = backend.run(thread, 'one', 'task', () => {}, controller.signal);
  controller.abort();
  await expect(
    factory.connect(cwd, env).run(thread, 'two', 'task', () => {}, new AbortController().signal),
  ).rejects.toThrow('active');
  expect(factory.activeTaskCount).toBe(1);
  finish('done');
  await running;
  expect(factory.activeTaskCount).toBe(0);
});

it('records output-limit aborts as errors rather than user cancellations', async () => {
  const { backend, execute, store } = fixture();
  const thread = await backend.start({});
  let finish!: (text: string) => void;
  execute.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const result = backend.run(thread, 'run', 'task', () => {}, controller.signal);
  controller.abort(new MulticaCodexStreamError('output exceeded limit'));
  finish('late answer');
  await expect(result).rejects.toThrow('output exceeded limit');
  expect(store.listSessions()[0].external?.status).toBe('error');
});

it('selects actual models independently from the main assistant', async () => {
  const { backend, store, execute } = fixture();
  expect(backend.models().map(model => model.id)).toEqual(['provider/default', 'other/selected']);
  const thread = await backend.start({ model: 'other/selected' });
  expect(thread).toMatchObject({ agentId: 'main', modelRef: 'other/selected' });
  expect(store.getSession(store.listSessions()[0].id)).toMatchObject({
    agentId: 'main',
    modelRef: 'other/selected',
  });
  await backend.run(thread, 'run', 'task', () => {}, new AbortController().signal);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ modelRef: 'other/selected' }));
});

it('allows a resumed connection to select a model without mutating an active conversation', async () => {
  const { backend, factory, cwd, env, store, execute } = fixture();
  const thread = await backend.start({});
  let finish!: (text: string) => void;
  execute.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const running = backend.run(thread, 'one', 'task', () => {}, new AbortController().signal);
  const other = factory.connect(cwd, env);
  const resumed = await other.resume(thread.id, { model: 'other/selected' });
  expect(resumed).toMatchObject({ id: thread.id, agentId: 'main', modelRef: 'other/selected' });
  expect(store.getSession(store.listSessions()[0].id)?.modelRef).toBe('provider/default');
  await expect(
    other.run(resumed, 'two', 'task', () => {}, new AbortController().signal),
  ).rejects.toThrow('active');
  finish('done');
  await running;
  execute.mockResolvedValue('next');
  await other.run(resumed, 'two', 'task', () => {}, new AbortController().signal);
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ modelRef: 'other/selected' }));
});

it('rejects unknown and subsequently disabled models before launching a run', async () => {
  const { backend, models, execute } = fixture();
  await expect(backend.start({ model: 'main' })).rejects.toThrow('selected model is unavailable');
  const thread = await backend.start({ model: 'other/selected' });
  models.pop();
  await expect(
    backend.run(thread, 'run', 'task', () => {}, new AbortController().signal),
  ).rejects.toThrow('selected model is unavailable');
  expect(execute).not.toHaveBeenCalled();
});

it('resumes a confirmed built-in identity through its catalog route while keeping explicit choices strict', async () => {
  const { backend, factory, cwd, env, store, models, execute } = fixture();
  const modelRef = `${OpenClawProviderId.BuiltinModels}/openai/internal`;
  models.push({ id: modelRef, name: 'Built-in model', isDefault: false });
  const thread = await backend.start({ model: modelRef });
  store.updateSession(store.listSessions()[0].id, { modelRef: 'openai/internal' });
  const next = factory.connect(cwd, env);
  const resumed = await next.resume(thread.id, {});
  expect(resumed.modelRef).toBe(modelRef);
  await next.run(resumed, 'next', 'task', () => {}, new AbortController().signal);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ modelRef }));
  await expect(
    factory.connect(cwd, env).resume(thread.id, { model: 'openai/internal' }),
  ).rejects.toThrow('selected model is unavailable');
});
