import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createCodexAppServerBackend } from './codexAppServerBackend';
import type { ExternalAgentBackend } from './externalAgentTypes';

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
