import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SHUTDOWN_BUDGET_MS as budget } from '../../../../shared/app/shutdownPolicy';
import { GatewayProcessShutdown } from './gatewayProcessShutdown';
import { OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } from './openclawLauncher';

const fixture = () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234, exitCode: null as number | null, signalCode: null as string | null,
    connected: true, send: vi.fn(), kill: vi.fn(),
  });
  const failed = vi.fn();
  const owner = new GatewayProcessShutdown(failed);
  const processChild = child as unknown as ChildProcess;
  owner.observe(processChild);
  return { child, owner, failed, processChild };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('native cleanup lasting beyond 15 seconds is joined at close, not exit', async () => {
  const h = fixture();
  let settled = false;
  const stopped = h.owner.stop(h.processChild).then(() => { settled = true; });
  expect(h.child.send).toHaveBeenCalledExactlyOnceWith(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE, expect.any(Function));
  await vi.advanceTimersByTimeAsync(25_000);
  expect(h.child.kill).not.toHaveBeenCalled();
  h.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  h.child.emit('close', 0, null);
  await stopped;
  expect(h.owner.failure).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test('same-child stop requests share the original promise and deadline', async () => {
  const h = fixture();
  const first = h.owner.stop(h.processChild);
  const rejected = expect(first).rejects.toThrow('grace period');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.owner.stop(h.processChild)).toBe(first);
  await vi.advanceTimersByTimeAsync(budget.gatewayGrace - 30_000);
  expect(h.child.kill).toHaveBeenCalledOnce();
  expect(h.child.send).toHaveBeenCalledOnce();
  let secondJoined = false;
  const second = h.owner.waitForStops().catch(() => { secondJoined = true; });
  h.child.emit('exit', null, 'SIGTERM');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(secondJoined).toBe(false);
  h.child.emit('close', null, 'SIGTERM');
  await rejected;
  await second;
  expect(secondJoined).toBe(true);
  expect(h.failed).toHaveBeenCalledOnce();
  await expect(h.owner.waitForStops()).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])('force without close stays unknown even when kill throws (%s)', async throws => {
  const h = fixture();
  if (throws) h.child.kill.mockImplementation(() => { throw new Error('signal failed'); });
  const stopped = h.owner.stop(h.processChild);
  const rejected = expect(stopped).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(budget.gatewayStop);
  await rejected;
  expect(h.child.kill).toHaveBeenCalledOnce();
  expect(h.owner.stop(h.processChild)).toBe(stopped);
  h.child.emit('close', 0, null);
  expect(h.owner.failure).toBeTruthy();
  await expect(h.owner.waitForStops()).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

test('exit before delayed close prevents late signalling of a retired PID', async () => {
  const h = fixture();
  const rejected = expect(h.owner.stop(h.processChild)).rejects.toThrow('grace period');
  h.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(budget.gatewayGrace);
  expect(h.child.kill).not.toHaveBeenCalled();
  h.child.emit('close', 0, null);
  await rejected;
});

test.each([[1, null], [null, 'SIGTERM']] as const)('nonclean close is never a successful stop (%s/%s)', async (code, signal) => {
  const h = fixture();
  const rejected = expect(h.owner.stop(h.processChild)).rejects.toThrow('did not close cleanly');
  h.child.emit('close', code, signal);
  await rejected;
  expect(h.owner.failure).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

test('a previously observed closed process retains its actual exit outcome', async () => {
  const h = fixture();
  h.child.emit('exit', 2, null);
  h.child.emit('close', 2, null);
  await expect(h.owner.stop(h.processChild)).rejects.toThrow('code=2');
  expect(h.child.send).not.toHaveBeenCalled();
  expect(h.child.kill).not.toHaveBeenCalled();
});

test('IPC closure does not replace the native grace or actual close proof', async () => {
  const h = fixture();
  h.child.send.mockImplementation(() => { throw new Error('pipe closed'); });
  const stopped = h.owner.stop(h.processChild);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.child.kill).not.toHaveBeenCalled();
  h.child.emit('close', 0, null);
  await stopped;
});

test('a pending native close remains an admission fence after exit', async () => {
  const h = fixture();
  const stopped = h.owner.stop(h.processChild);
  let joined = false;
  const wait = h.owner.waitForStops().then(() => { joined = true; });
  h.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(1);
  expect(joined).toBe(false);
  h.child.emit('close', 0, null);
  await Promise.all([stopped, wait]);
  expect(joined).toBe(true);
});

test.each(['close', 'deadline'])('a throwing failure observer cannot interrupt the %s verdict', async trigger => {
  const h = fixture();
  const projectionError = new Error('status observer failed');
  h.failed.mockImplementation(() => { throw projectionError; });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const stopped = h.owner.stop(h.processChild);
    const rejected = expect(stopped).rejects.toThrow();
    if (trigger === 'close') expect(() => h.child.emit('close', 1, null)).not.toThrow();
    else await vi.advanceTimersByTimeAsync(budget.gatewayStop);
    await rejected;
    expect(h.owner.failure).toBe(h.failed.mock.calls[0][0]);
    expect(h.owner.failure).not.toBe(projectionError);
    expect(h.failed).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith('[GatewayShutdown] Failed to publish retirement failure:', projectionError);
    expect(h.child.kill).toHaveBeenCalledTimes(trigger === 'deadline' ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { logged.mockRestore(); }
});
