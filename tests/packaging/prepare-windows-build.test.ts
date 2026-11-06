import { EventEmitter } from 'node:events';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { prepareOpenClawRuntime, prepareWindowsResources } = require('../../scripts/packaging/prepare-windows-build.cjs') as {
  prepareOpenClawRuntime: (options: Record<string, unknown>) => Promise<{ reused: boolean }>;
  prepareWindowsResources: (options: Record<string, unknown>) => Promise<void>;
};

function processHarness() {
  const jobs: Array<{ args: string[]; options: { env: Record<string, string>; windowsHide: boolean; cwd: string }; child: EventEmitter }> = [];
  const spawn = vi.fn((_executable: string, args: string[], options: typeof jobs[number]['options']) => {
    const child = new EventEmitter();
    jobs.push({ args, options, child });
    return child;
  });
  return { jobs, spawn, log: vi.fn() };
}

test('reuses only a successfully verified frozen Windows runtime', async () => {
  const harness = processHarness();
  const verify = vi.fn(() => ({ patches: Array(30).fill({}) }));
  const repoRoot = path.resolve('runtime-fixture');
  await expect(prepareOpenClawRuntime({ ...harness, repoRoot, env: {}, verify })).resolves.toEqual({ reused: true });
  expect(verify).toHaveBeenCalledWith(path.join(repoRoot, 'vendor/openclaw-runtime/current'), { repoRoot, expectedTarget: 'win-x64' });
  expect(harness.spawn).not.toHaveBeenCalled();
});

test('replaces a stale runtime from the pristine package and verifies the result', async () => {
  const harness = processHarness();
  const verify = vi.fn().mockImplementationOnce(() => { throw new Error('stale source proof'); }).mockReturnValue({ patches: [] });
  const env = { npm_execpath: 'C:/Node with spaces/npm-cli.js', CUSTOM_BUILD_SETTING: 'preserved' };
  const work = prepareOpenClawRuntime({ ...harness, env, verify });
  expect(harness.jobs).toHaveLength(1);
  expect(harness.jobs[0].args).toEqual([env.npm_execpath, 'run', 'openclaw:runtime:win-x64']);
  expect(harness.jobs[0].options.env).toEqual({ ...env, OPENCLAW_FORCE_INSTALL: '1' });
  expect(env).not.toHaveProperty('OPENCLAW_FORCE_INSTALL');
  expect(harness.jobs[0].options.windowsHide).toBe(true);
  harness.jobs[0].child.emit('close', 0, null);
  await expect(work).resolves.toEqual({ reused: false });
  expect(verify).toHaveBeenCalledTimes(2);
});

test('honors an explicit forced reinstall even when a verified runtime exists', async () => {
  const harness = processHarness();
  const verify = vi.fn(() => ({ patches: [] }));
  const work = prepareOpenClawRuntime({ ...harness, env: { npm_execpath: 'npm-cli.js', OPENCLAW_FORCE_INSTALL: '1' }, verify });
  expect(verify).not.toHaveBeenCalled();
  harness.jobs[0].child.emit('close', 0, null);
  await work;
  expect(verify).toHaveBeenCalledTimes(1);
});

test('fails a rebuild with a nonzero exit without accepting old proof', async () => {
  const harness = processHarness();
  const verify = vi.fn(() => { throw new Error('source missing'); });
  const work = prepareOpenClawRuntime({ ...harness, env: { npm_execpath: 'npm-cli.js' }, verify });
  harness.jobs[0].child.emit('close', 7, null);
  await expect(work).rejects.toThrow(/exit 7/);
  expect(verify).toHaveBeenCalledTimes(1);
});

test('does not accept a successful command that leaves invalid runtime proof', async () => {
  const harness = processHarness();
  const verify = vi.fn(() => { throw new Error('incomplete rebuilt runtime'); });
  const work = prepareOpenClawRuntime({ ...harness, env: { npm_execpath: 'npm-cli.js' }, verify });
  harness.jobs[0].child.emit('close', 0, null);
  await expect(work).rejects.toThrow(/incomplete rebuilt runtime/);
});

test('starts independent resource processes together and waits for all of them on failure', async () => {
  const harness = processHarness();
  let settled = false;
  const work = prepareWindowsResources(harness).finally(() => { settled = true; });
  expect(harness.jobs.map(job => job.args.slice(1))).toEqual([
    ['--resource', 'python'], ['--resource', 'git'], ['--resource', 'speech'],
  ]);
  harness.jobs[1].child.emit('close', 3, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  harness.jobs[0].child.emit('close', 0, null);
  harness.jobs[2].child.emit('close', 0, null);
  await expect(work).rejects.toThrow(/git:.*exit 3/);
  expect(settled).toBe(true);
});

test('waits for siblings after a process launch failure', async () => {
  const harness = processHarness();
  const work = prepareWindowsResources(harness);
  harness.jobs[0].child.emit('error', new Error('EACCES launching Python preparation'));
  harness.jobs[1].child.emit('close', 0, null);
  harness.jobs[2].child.emit('close', 0, null);
  await expect(work).rejects.toThrow(/python:.*EACCES/);
});
