import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createCodexAppServerBackend } from './codexAppServerBackend';
import type { ExternalAgentBackend, ExternalAgentThreadMetadata } from './externalAgentTypes';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })),
);
function setup(codexHome?: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backend-'));
  directories.push(cwd);
  const thread = { id: randomUUID(), cwd, agentId: 'main', modelRef: 'provider/model' };
  const backend: ExternalAgentBackend = {
    models: vi.fn(() => []),
    start: vi.fn(async params => {
      params.onCreated?.(thread);
      return thread;
    }),
    resume: vi.fn(async () => thread),
    run: vi.fn(async () => 'Answer'),
  };
  const adapter = createCodexAppServerBackend(backend, { cwd, codexHome });
  return { cwd, thread, backend, adapter };
}

it('uses generic session identity, model routing and launch defaults without client environment', async () => {
  const h = setup();
  await expect(h.adapter.start({ model: 'provider/model' })).resolves.toEqual(h.thread);
  expect(h.backend.start).toHaveBeenCalledWith({ cwd: h.cwd, model: 'provider/model' });
  await h.adapter.start({ cwd: 'child' });
  expect(h.backend.start).toHaveBeenLastCalledWith({
    cwd: path.join(h.cwd, 'child'),
    model: undefined,
  });
  await h.adapter.resume(h.thread.id, {});
  expect(h.backend.resume).toHaveBeenCalledWith(h.thread.id, { model: undefined });
  await h.adapter.resume(h.thread.id, { cwd: 'child', model: 'provider/selected' });
  expect(h.backend.resume).toHaveBeenLastCalledWith(h.thread.id, {
    cwd: path.join(h.cwd, 'child'),
    model: 'provider/selected',
  });
  expect(fs.existsSync(path.join(h.cwd, 'sessions'))).toBe(false);
});

it('prepares optional discovery metadata before start and never uses it as resume authority', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  directories.push(home);
  const h = setup(home);
  await h.adapter.start({});
  const marker = path.join(home, 'sessions', `rollout-external-${h.thread.id}.jsonl`);
  expect(fs.existsSync(marker)).toBe(true);
  h.backend.resume = vi.fn(async () => {
    throw new Error('Mapping is unavailable');
  });
  await expect(h.adapter.resume(h.thread.id, {})).rejects.toThrow('Mapping is unavailable');
  expect(h.backend.resume).toHaveBeenCalledWith(h.thread.id, { model: undefined });
  const invalid = createCodexAppServerBackend(h.backend, { cwd: h.cwd, codexHome: 'relative' });
  await expect(invalid.start({})).rejects.toThrow('absolute');
  expect(h.backend.start).toHaveBeenCalledTimes(1);
});

it('forwards metadata and rename capabilities without reading or writing client discovery markers', async () => {
  const h = setup();
  const metadata: ExternalAgentThreadMetadata = {
    ...h.thread,
    name: 'Stored title',
    createdAt: 10,
    updatedAt: 20,
    permissionMode: 'auto',
    status: 'completed',
  };
  h.backend.describe = vi.fn(() => metadata);
  h.backend.list = vi.fn(() => [metadata]);
  h.backend.setName = vi.fn();
  h.backend.history = vi.fn(async () => ({ threadId: h.thread.id, messages: [], runs: [] }));
  // An invalid marker directory proves these read/name paths never prepare it.
  const adapter = createCodexAppServerBackend(h.backend, { cwd: h.cwd, codexHome: 'relative' });

  expect(adapter.describe!(h.thread.id)).toBe(metadata);
  expect(adapter.list!()).toEqual([metadata]);
  adapter.setName!(h.thread.id, 'New title');
  const historyRead = adapter.history!(h.thread.id);

  expect(h.backend.describe).toHaveBeenCalledExactlyOnceWith(h.thread.id);
  expect(h.backend.list).toHaveBeenCalledOnce();
  expect(h.backend.setName).toHaveBeenCalledExactlyOnceWith(h.thread.id, 'New title');
  await expect(historyRead).resolves.toEqual({ threadId: h.thread.id, messages: [], runs: [] });
  expect(h.backend.start).not.toHaveBeenCalled();
  expect(h.backend.resume).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(h.cwd, 'sessions'))).toBe(false);
});
