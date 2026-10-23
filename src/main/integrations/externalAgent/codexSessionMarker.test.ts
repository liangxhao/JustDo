import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { prepareCodexSessionMarker } from './codexSessionMarker';

const directories: string[] = [];
const directory = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-marker-'));
  directories.push(value);
  return value;
};
afterEach(() =>
  directories.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })),
);

it('writes an idempotent identity-only marker without messages or credentials', () => {
  const home = directory();
  const thread = { id: randomUUID(), cwd: home, agentId: 'main' };
  const write = prepareCodexSessionMarker(home);
  write(thread);
  write(thread);
  const marker = path.join(home, 'sessions', `rollout-external-${thread.id}.jsonl`);
  expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({
    type: 'session_meta',
    payload: { id: thread.id, cwd: home, originator: 'external-agent' },
  });
  expect(fs.readdirSync(path.dirname(marker))).toEqual([path.basename(marker)]);
  expect(() => write({ ...thread, cwd: path.dirname(home) })).toThrow('conflicting ownership');
  expect(() => write({ ...thread, id: '../foreign' })).toThrow('identity');
  expect(() => prepareCodexSessionMarker('relative-home')).toThrow('absolute');
});

it('allows the client-owned sessions directory to link to its own discovery store', () => {
  const home = directory();
  const target = directory();
  fs.symlinkSync(
    target,
    path.join(home, 'sessions'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const thread = { id: randomUUID(), cwd: home, agentId: 'main' };
  prepareCodexSessionMarker(home)(thread);
  expect(fs.readdirSync(target)).toEqual([`rollout-external-${thread.id}.jsonl`]);
});

it('never replaces an existing marker directory', () => {
  const home = directory();
  const write = prepareCodexSessionMarker(home);
  const thread = { id: randomUUID(), cwd: home, agentId: 'main' };
  const marker = path.join(home, 'sessions', `rollout-external-${thread.id}.jsonl`);
  fs.mkdirSync(marker);
  expect(() => write(thread)).toThrow();
  expect(fs.statSync(marker).isDirectory()).toBe(true);
});

it.skipIf(process.platform === 'win32')(
  'rejects a marker-file symlink without modifying its target',
  () => {
    const home = directory();
    const write = prepareCodexSessionMarker(home);
    const thread = { id: randomUUID(), cwd: home, agentId: 'main' };
    const target = path.join(home, 'private');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, path.join(home, 'sessions', `rollout-external-${thread.id}.jsonl`));
    expect(() => write(thread)).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  },
);
