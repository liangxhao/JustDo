import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import developmentParent from '../../../shared/app/developmentParent.json';
import { bindDevelopmentParentShutdown, createDevSessionLifecycle, probeDevServer } from './devSessionLifecycle';

afterEach(() => vi.useRealTimers());

describe('development session lifecycle', () => {
  test('stops startup if its inherited parent pipe closed before registration', () => {
    const parent = Object.assign(new EventEmitter(), { connected: false, send: vi.fn() });
    const quit = vi.fn();
    bindDevelopmentParentShutdown(quit, parent as never)();
    expect(quit).toHaveBeenCalledOnce();
    expect(parent.listenerCount('message')).toBe(0);
  });

  test('releases an old launcher after another development server takes ownership', () => {
    const parent = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
    const quit = vi.fn();
    const detach = bindDevelopmentParentShutdown(quit, parent as never, () => false);
    parent.emit('message', developmentParent.shutdown);
    parent.emit('disconnect');
    expect(quit).not.toHaveBeenCalled();
    expect(parent.send).toHaveBeenCalledWith(developmentParent.released, expect.any(Function));
    detach();
  });

  test('accepts only the owned parent shutdown message and retires its listeners', () => {
    const parent = Object.assign(new EventEmitter(), { connected: true, channel: { unref: vi.fn() } });
    const quit = vi.fn();
    const detach = bindDevelopmentParentShutdown(quit, parent as never);
    parent.emit('message', { type: developmentParent.shutdown });
    parent.emit('message', 'unrelated');
    expect(quit).not.toHaveBeenCalled();
    parent.emit('message', developmentParent.shutdown);
    parent.emit('disconnect');
    expect(quit).toHaveBeenCalledOnce();
    expect(parent.channel.unref).toHaveBeenCalledOnce();
    detach();
    expect(parent.listenerCount('message')).toBe(0);
    expect(parent.listenerCount('disconnect')).toBe(0);
  });

  test('quits on parent loss and leaves unowned launchers alone', () => {
    const parent = Object.assign(new EventEmitter(), { connected: false });
    const quit = vi.fn();
    bindDevelopmentParentShutdown(quit, parent as never)();
    expect(parent.listenerCount('disconnect')).toBe(0);
    parent.connected = true;
    const detach = bindDevelopmentParentShutdown(quit, parent as never);
    parent.emit('disconnect');
    expect(quit).toHaveBeenCalledOnce();
    detach();
  });
  test('exits once after the current server stops, even without a parent signal', async () => {
    vi.useFakeTimers();
    const ended = vi.fn();
    const probe = vi.fn().mockResolvedValue(true);
    const lifecycle = createDevSessionLifecycle(ended, probe);
    lifecycle.follow('http://localhost:43127');
    await vi.advanceTimersByTimeAsync(1000);
    probe.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toHaveBeenCalledOnce();
  });

  test('resets failures after a temporary interruption', async () => {
    vi.useFakeTimers();
    const ended = vi.fn();
    const probe = vi.fn().mockResolvedValue(false);
    const lifecycle = createDevSessionLifecycle(ended, probe);
    lifecycle.follow('http://localhost:43127');
    await vi.advanceTimersByTimeAsync(2000);
    probe.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ended).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  test('ignores pending failures from the old server after a handoff or stop', async () => {
    vi.useFakeTimers();
    const ended = vi.fn();
    let finish!: (alive: boolean) => void;
    const probe = vi.fn().mockResolvedValue(false);
    const lifecycle = createDevSessionLifecycle(ended, probe);
    lifecycle.follow('http://localhost:43127');
    await vi.advanceTimersByTimeAsync(2000);
    probe.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    lifecycle.follow('http://localhost:43128');
    finish(false);
    probe.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(probe).toHaveBeenLastCalledWith('http://localhost:43128/');
    expect(ended).not.toHaveBeenCalled();
    lifecycle.stop();
    const count = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(count);
  });

  test('does not monitor non-loopback URLs', async () => {
    vi.useFakeTimers();
    const probe = vi.fn();
    createDevSessionLifecycle(vi.fn(), probe).follow('http://example.com:43127');
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).not.toHaveBeenCalled();
  });

  test('detects a real listening server and its shutdown', async () => {
    const server = createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      expect(await probeDevServer(url)).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(await probeDevServer(url)).toBe(false);
  });
});
