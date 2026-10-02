import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
  return {
    app: {
      exit: vi.fn(),
      on: vi.fn((event: string, handler: (event: { preventDefault: () => void }) => void) => {
        handlers.set(event, handler);
      }),
    },
    handlers,
  };
});

vi.mock('electron', () => ({ app: electronMocks.app }));

import { registerAppShutdown } from './appShutdown';

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('registerAppShutdown', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.app.exit.mockClear();
    electronMocks.app.on.mockClear();
    vi.spyOn(process, 'once').mockReturnValue(process);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('forces development exit when cleanup never finishes', async () => {
    vi.useFakeTimers();
    registerAppShutdown({ cleanup: () => new Promise(() => {}), cleanupTimeoutMs: 10_000 });
    electronMocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(9999);
    expect(electronMocks.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(electronMocks.app.exit).toHaveBeenCalledWith(1);
  });

  test('cancels the development timeout after successful cleanup', async () => {
    vi.useFakeTimers();
    registerAppShutdown({ cleanup: async () => undefined, cleanupTimeoutMs: 10_000 });
    electronMocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(electronMocks.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  test('stops the runtime independently when session cleanup hangs, then exits', async () => {
    vi.useFakeTimers();
    let stopped!: () => void;
    const stopRuntime = vi.fn(
      () =>
        new Promise<void>(resolve => {
          stopped = resolve;
        }),
    );
    registerAppShutdown({
      cleanup: () => new Promise(() => {}),
      cleanupTimeoutMs: 10_000,
      onCleanupTimeout: stopRuntime,
    });
    electronMocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopRuntime).toHaveBeenCalledOnce();
    expect(electronMocks.app.exit).not.toHaveBeenCalled();
    stopped();
    await vi.advanceTimersByTimeAsync(0);
    expect(electronMocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
    await vi.advanceTimersByTimeAsync(17_000);
    expect(electronMocks.app.exit).toHaveBeenCalledOnce();
  });

  test('bounds emergency cleanup too', async () => {
    vi.useFakeTimers();
    registerAppShutdown({
      cleanup: () => new Promise(() => {}),
      cleanupTimeoutMs: 10_000,
      onCleanupTimeout: () => new Promise(() => {}),
    });
    electronMocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(27_000);
    expect(electronMocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  test('waits for emergency runtime shutdown even if normal cleanup recovers', async () => {
    vi.useFakeTimers();
    let finishCleanup!: () => void;
    let finishRuntime!: () => void;
    registerAppShutdown({
      cleanup: () =>
        new Promise<void>(resolve => {
          finishCleanup = resolve;
        }),
      cleanupTimeoutMs: 10_000,
      onCleanupTimeout: () =>
        new Promise<void>(resolve => {
          finishRuntime = resolve;
        }),
    });
    electronMocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    finishCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(electronMocks.app.exit).not.toHaveBeenCalled();
    finishRuntime();
    await vi.advanceTimersByTimeAsync(0);
    expect(electronMocks.app.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  test.each(['SIGINT', 'SIGTERM'])(
    'runs cleanup for %s without a window close event',
    async signal => {
      const cleanup = vi.fn(async () => undefined);
      const controller = registerAppShutdown({ cleanup });
      const listener = vi.mocked(process.once).mock.calls.find(([event]) => event === signal)?.[1];
      expect(listener).toBeDefined();
      listener?.();
      await flushPromises();
      expect(controller.isQuitting()).toBe(true);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(electronMocks.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    },
  );

  test('runs cleanup before a normal application exit', async () => {
    const cleanup = vi.fn(async () => undefined);
    registerAppShutdown({ cleanup });
    const event = { preventDefault: vi.fn() };

    electronMocks.handlers.get('before-quit')?.(event);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(electronMocks.app.exit).toHaveBeenCalledWith(0);
  });

  test('runs cleanup and then launches the update without forcing app.exit', async () => {
    const cleanup = vi.fn(async () => undefined);
    const installUpdate = vi.fn();
    const controller = registerAppShutdown({ cleanup });

    controller.quitAndInstall(installUpdate);
    await flushPromises();

    expect(controller.isQuitting()).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(installUpdate).toHaveBeenCalledOnce();
    expect(electronMocks.app.exit).not.toHaveBeenCalled();
  });

  test('still launches the update after cleanup rejects', async () => {
    const cleanup = vi.fn(async () => Promise.reject(new Error('cleanup failed')));
    const installUpdate = vi.fn();
    const controller = registerAppShutdown({ cleanup });

    controller.quitAndInstall(installUpdate);
    await flushPromises();

    expect(installUpdate).toHaveBeenCalledOnce();
    expect(electronMocks.app.exit).not.toHaveBeenCalled();
  });

  test('exits with failure when the installer cannot be launched', async () => {
    const controller = registerAppShutdown({ cleanup: async () => undefined });
    controller.quitAndInstall(() => {
      throw new Error('installer failed');
    });
    await flushPromises();

    expect(electronMocks.app.exit).toHaveBeenCalledWith(1);
  });
});
