import { EventEmitter } from 'events';
import { afterEach, expect, test, vi } from 'vitest';

import { NativeHistoryRuntime } from './nativeHistoryRuntime';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));
afterEach(() => vi.clearAllMocks());
const environment = { runtimeRoot: '/bundled', openclawEntry: '/bundled/openclaw.mjs', env: { JUSTDO_ELECTRON_PATH: '/bundled/node.exe' } };

test('a live Gateway cannot start an offline history operation', async () => {
  const getEnvironment = vi.fn();
  const runtime = new NativeHistoryRuntime({
    getEnvironment,
    gatewayStopped: () => false,
    stateDir: () => '/state',
  });
  await expect(runtime.run('import')).rejects.toThrow(/stopped Gateway/);
  expect(getEnvironment).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

test.each(['import', 'inspect'] as const)('offline history %s selects only main, including on interrupted migration retry', async mode => {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() { return this; } });
  const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), kill: vi.fn() });
  spawnMock.mockReturnValue(child);
  const runtime = new NativeHistoryRuntime({ getEnvironment: async () => environment,
    gatewayStopped: () => true, stateDir: () => '/state' });
  const operation = runtime.run(mode);
  await Promise.resolve();
  expect(spawnMock.mock.calls[0][1]).toEqual([
    environment.openclawEntry, 'doctor', '--session-sqlite', mode,
    '--session-sqlite-agent', 'main', '--json',
  ]);
  child.stdout.emit('data', '{"targets":[]}');
  child.emit('close', 0);
  await expect(operation).resolves.toBe('{"targets":[]}');
});

test('Quit waits for native retirement and leaves an interrupted import unconfirmed', async () => {
  const stream = () =>
    Object.assign(new EventEmitter(), {
      setEncoding() {
        return this;
      },
    });
  const child = Object.assign(new EventEmitter(), {
    stdout: stream(),
    stderr: stream(),
    kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);
  const runtime = new NativeHistoryRuntime({
    getEnvironment: async () => environment,
    gatewayStopped: () => true,
    stateDir: () => '/state',
  });
  const operation = runtime.run('import');
  const rejected = expect(operation).rejects.toThrow(/interrupted/);
  await Promise.resolve();
  let retired = false;
  const stop = runtime.stop().then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(retired).toBe(false);
  child.emit('close', null);
  await rejected;
  await stop;
  expect(retired).toBe(true);
  expect(spawnMock.mock.calls[0][2]).toMatchObject({
    windowsHide: true,
    env: { ELECTRON_RUN_AS_NODE: '1', OPENCLAW_NO_RESPAWN: '1' },
  });
});
