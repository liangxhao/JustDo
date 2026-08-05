import { beforeEach, describe, expect, test, vi } from 'vitest';

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
  });

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
