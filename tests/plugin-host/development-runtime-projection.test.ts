import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { DEVELOPMENT_APPLICATION_BODY_COMPLETE, waitForDevelopmentApplication } from '../../scripts/test/plugin-host/project-development-runtime.mjs';

afterEach(() => vi.useRealTimers());

test('projects only current companion bytes into a private prepared runtime without changing its source', async () => {
  const buildRoot = path.resolve('build');
  await mkdir(buildRoot, { recursive: true });
  const directory = await mkdtemp(path.join(buildRoot, 'development-projection-'));
  const repo = path.join(directory, 'repository');
  const root = path.join(repo, '.work', 'app-plugin-hot-proof');
  const runtime = path.join(directory, 'prepared');
  const hash = 'a'.repeat(64);
  const artifactRoot = path.join(repo, 'build/app-plugins', 'agent-team', hash);
  const packageRoot = path.join(repo, 'build/app-plugins/packages', 'agent-team', hash);
  const nativeBytes = 'export default { id: "agent-team" };';
  const artifact = { manifest: { id: 'agent-team' }, hash, files: {} };
  const binding = { entry: 'index.js', sha256: createHash('sha256').update(nativeBytes).digest('hex') };
  const put = async (file: string, bytes: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  };
  await mkdir(root, { recursive: true });
  await mkdir(path.join(repo, 'resources'), { recursive: true });
  await mkdir(path.join(repo, 'plugins'), { recursive: true });
  await put(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture' }));
  await put(path.join(repo, 'scripts/openclaw/openclaw-runtime-dev-lease.cjs'), 'real-lease-module');
  await put(path.join(runtime, 'package.json'), JSON.stringify({ version: 'prepared-native-fixture' }));
  await put(path.join(runtime, 'gateway-launcher.cjs'), 'prepared-launcher');
  await put(path.join(runtime, 'gateway-bundle.mjs'), 'prepared-bundle');
  await put(path.join(runtime, 'dist/gateway/client.js'), 'prepared-client');
  await put(path.join(runtime, 'dist/extensions/agent-team/index.js'), 'old-native');
  await put(path.join(runtime, 'dist/extensions/runtime-services/node_modules/dependency/package.json'), '{}');
  await put(path.join(runtime, 'node_modules/dependency/package.json'), '{}');
  await put(path.join(repo, 'build/app-plugins/catalog.json'), JSON.stringify([{ id: 'agent-team', hash }]));
  await put(path.join(artifactRoot, 'app.artifact.json'), JSON.stringify(artifact));
  await put(path.join(artifactRoot, 'native.binding.json'), JSON.stringify(binding));
  await put(path.join(packageRoot, 'app/app.artifact.json'), JSON.stringify(artifact));
  await put(path.join(packageRoot, 'index.js'), nativeBytes);
  await put(path.join(repo, 'build/app-plugins/agent-team', 'b'.repeat(64), 'old.js'), 'stale-artifact');
  let links: string[] = [];
  try {
    const { projectDevelopmentRuntime } = await import('../../scripts/test/plugin-host/project-development-runtime.mjs');
    const projected = await projectDevelopmentRuntime({ repo, root, runtime });
    links = projected.links;
    expect(projected.runtimeVersion).toBe('prepared-native-fixture');
    expect(await readFile(path.join(projected.appRoot, 'scripts/openclaw/openclaw-runtime-dev-lease.cjs'), 'utf8'))
      .toBe('real-lease-module');
    expect(await readFile(path.join(runtime, 'dist/extensions/agent-team/index.js'), 'utf8')).toBe('old-native');
    expect(await readFile(path.join(projected.runtimeRoot, 'dist/extensions/agent-team/index.js'), 'utf8')).toBe(nativeBytes);
    expect(await readFile(path.join(projected.runtimeRoot, 'dist/gateway/client.js'), 'utf8')).toBe('prepared-client');
    expect(await readFile(path.join(packageRoot, 'index.js'), 'utf8')).toBe(nativeBytes);
    expect((await lstat(path.join(projected.runtimeRoot, 'dist'))).isSymbolicLink()).toBe(false);
    expect(await realpath(path.join(projected.runtimeRoot, 'node_modules')))
      .toBe(await realpath(path.join(runtime, 'node_modules')));
    expect(await realpath(path.join(projected.runtimeRoot, 'dist/extensions/runtime-services/node_modules')))
      .toBe(await realpath(path.join(runtime, 'dist/extensions/runtime-services/node_modules')));
    expect(await realpath(path.join(projected.appRoot, 'vendor/openclaw-runtime/current')))
      .toBe(await realpath(projected.runtimeRoot));
    expect(await readFile(path.join(projected.appRoot, 'build/app-plugins/catalog.json'), 'utf8'))
      .toBe(JSON.stringify([{ id: 'agent-team', hash }]));
    await expect(access(path.join(projected.appRoot, 'build/app-plugins/agent-team', 'b'.repeat(64))))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(projectDevelopmentRuntime({ repo, root, runtime: repo }))
      .rejects.toThrow('do not overlap');
  } finally {
    for (const link of [...links].reverse()) await unlink(link);
    const relative = path.relative(buildRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unsafe projection fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

test('ends only the body deadline on its versioned completion message and waits for real clean close', async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  let finish!: () => void;
  const shutdown = new Promise<void>(resolve => { finish = resolve; });
  const finishShutdown = vi.fn(() => shutdown);
  const waiting = waitForDevelopmentApplication(child, { bodyTimeoutMs: 100, finishShutdown });
  let completed = false;
  void waiting.then(() => { completed = true; });
  child.emit('message', { ...DEVELOPMENT_APPLICATION_BODY_COMPLETE, version: 0 });
  await vi.advanceTimersByTimeAsync(99);
  expect(finishShutdown).not.toHaveBeenCalled();
  child.emit('message', DEVELOPMENT_APPLICATION_BODY_COMPLETE);
  await vi.advanceTimersByTimeAsync(1000);
  expect(completed).toBe(false);
  expect(finishShutdown).toHaveBeenCalledExactlyOnceWith(child);
  child.emit('close', 0, null);
  await Promise.resolve();
  expect(completed).toBe(false);
  finish();
  await expect(waiting).resolves.toBe(0);
  expect(child.listenerCount('message')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
});

test('keeps a failed cleanup failed after a later close', async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  let fail!: (error: Error) => void;
  const shutdown = new Promise<void>((_resolve, reject) => { fail = reject; });
  const waiting = waitForDevelopmentApplication(child, {
    bodyTimeoutMs: 100, finishShutdown: () => shutdown,
  });
  child.emit('message', DEVELOPMENT_APPLICATION_BODY_COMPLETE);
  await vi.advanceTimersByTimeAsync(0);
  const error = new Error('Cleanup remains unconfirmed');
  const rejection = expect(waiting).rejects.toBe(error);
  fail(error);
  await rejection;
  child.emit('close', 0, null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.listenerCount('close')).toBe(0);
});

test('returns a real startup failure close without requiring a completed body', async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  const finishShutdown = vi.fn();
  const waiting = waitForDevelopmentApplication(child, { bodyTimeoutMs: 100, finishShutdown });
  child.emit('close', 1, null);
  await expect(waiting).resolves.toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(finishShutdown).not.toHaveBeenCalled();
});

test('fails the existing body deadline when no body completion or close arrives', async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  const finishShutdown = vi.fn();
  const waiting = waitForDevelopmentApplication(child, { bodyTimeoutMs: 100, finishShutdown });
  const rejection = expect(waiting).rejects.toThrow('test body exceeded its deadline');
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  expect(finishShutdown).not.toHaveBeenCalled();
  expect(child.listenerCount('close')).toBe(0);
});

test('never substitutes cleanup acknowledgement or an unexpected clean exit for the required proof', async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  const waiting = waitForDevelopmentApplication(child, {
    bodyTimeoutMs: 100, finishShutdown: async () => undefined,
  });
  child.emit('message', DEVELOPMENT_APPLICATION_BODY_COMPLETE);
  await expect(waiting).rejects.toThrow('without an actual close event');
  const early = new EventEmitter();
  const missingBody = waitForDevelopmentApplication(early, {
    bodyTimeoutMs: 100, finishShutdown: vi.fn(),
  });
  early.emit('close', 0, null);
  await expect(missingBody).rejects.toThrow('without completing its test body');
});
