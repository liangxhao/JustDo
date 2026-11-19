import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startApplicationRendererHost } from './applicationRendererHost';
import { loadPackagedRenderer } from './packagedRendererLoader';

vi.mock('./applicationRendererHost', () => ({ startApplicationRendererHost: vi.fn() }));

const rendererUrl = 'http://127.0.0.1:45001/index.html';
const setup = () => {
  const webContents = Object.assign(new EventEmitter(), { stop: vi.fn() });
  return {
    window: Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      webContents,
      loadURL: vi.fn(async (_url: string) => {
        webContents.emit('did-navigate', {}, rendererUrl, 200);
      }),
    }),
    application: new EventEmitter(),
    host: {
      origin: 'http://127.0.0.1:45001',
      url: rendererUrl,
      close: vi.fn(() => Promise.resolve()),
    },
    onUrl: vi.fn(),
  };
};

describe('packaged renderer lifetime', () => {
  afterEach(() => vi.clearAllMocks());

  it('loads the admitted origin and closes its listener when the window is destroyed', async () => {
    const state = setup();
    vi.mocked(startApplicationRendererHost).mockResolvedValue(state.host);
    await loadPackagedRenderer(state.window, state.application, '/packaged/dist', state.onUrl);
    expect(state.onUrl).toHaveBeenCalledWith(state.host.url);
    expect(state.window.loadURL).toHaveBeenCalledWith(state.host.url);
    state.window.emit('closed');
    expect(state.host.close).toHaveBeenCalledOnce();
    expect(state.onUrl).toHaveBeenLastCalledWith(undefined);
    expect(state.application.listenerCount('before-quit')).toBe(0);
  });

  it('revokes origin admission and closes on application shutdown before window close', async () => {
    const state = setup();
    vi.mocked(startApplicationRendererHost).mockResolvedValue(state.host);
    await loadPackagedRenderer(state.window, state.application, '/packaged/dist', state.onUrl);
    state.application.emit('before-quit');
    expect(state.host.close).toHaveBeenCalledOnce();
    expect(state.onUrl).toHaveBeenLastCalledWith(undefined);
    expect(state.window.listenerCount('closed')).toBe(0);
    state.window.emit('closed');
    expect(state.host.close).toHaveBeenCalledOnce();
  });

  it('closes a late startup result after destruction without navigating the old window', async () => {
    const state = setup();
    let finish!: (host: typeof state.host) => void;
    vi.mocked(startApplicationRendererHost).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const loading = loadPackagedRenderer(
      state.window,
      state.application,
      '/packaged/dist',
      state.onUrl,
    );
    state.window.emit('closed');
    finish(state.host);
    await loading;
    expect(state.window.loadURL).not.toHaveBeenCalled();
    expect(state.host.close).toHaveBeenCalledOnce();
    expect(state.onUrl).not.toHaveBeenCalledWith(state.host.url);
  });

  it('cleans up when host startup or window loading fails', async () => {
    const first = setup();
    vi.mocked(startApplicationRendererHost).mockRejectedValue(new Error('No renderer'));
    await expect(
      loadPackagedRenderer(first.window, first.application, '/missing', first.onUrl),
    ).rejects.toThrow('No renderer');
    expect(first.application.listenerCount('before-quit')).toBe(0);
    expect(first.window.loadURL).not.toHaveBeenCalled();

    const second = setup();
    vi.mocked(startApplicationRendererHost).mockResolvedValue(second.host);
    second.window.loadURL.mockRejectedValue(new Error('Navigation failed'));
    await expect(
      loadPackagedRenderer(second.window, second.application, '/packaged/dist', second.onUrl),
    ).rejects.toThrow('Navigation failed');
    expect(second.host.close).toHaveBeenCalledOnce();
    expect(second.onUrl).toHaveBeenLastCalledWith(undefined);
  });

  it('recovers a temporary reset on the same validated origin', async () => {
    const state = setup();
    vi.mocked(startApplicationRendererHost).mockResolvedValue(state.host);
    state.window.loadURL.mockRejectedValueOnce(Object.assign(new Error('connection reset'), {
      code: 'ERR_CONNECTION_RESET',
    }));

    await expect(loadPackagedRenderer(state.window, state.application, '/packaged/dist', state.onUrl))
      .resolves.toBe(true);

    expect(startApplicationRendererHost).toHaveBeenCalledOnce();
    expect(state.window.loadURL.mock.calls).toHaveLength(2);
    expect(state.window.loadURL).toHaveBeenNthCalledWith(1, rendererUrl);
    expect(state.window.loadURL).toHaveBeenNthCalledWith(2, rendererUrl);
    expect(state.onUrl).toHaveBeenCalledExactlyOnceWith(rendererUrl);
    expect(state.host.close).not.toHaveBeenCalled();
    state.window.emit('closed');
  });

  it('rejects a non-200 main document even when Electron resolves the navigation', async () => {
    const state = setup();
    vi.mocked(startApplicationRendererHost).mockResolvedValue(state.host);
    state.window.loadURL.mockImplementation(async () => {
      state.window.webContents.emit('did-navigate', {}, rendererUrl, 404);
    });

    await expect(loadPackagedRenderer(state.window, state.application, '/packaged/dist', state.onUrl))
      .rejects.toThrow('returned 404');

    expect(state.window.loadURL).toHaveBeenCalledOnce();
    expect(state.host.close).toHaveBeenCalledOnce();
  });

  it('ends retry backoff promptly on quit without another navigation', async () => {
    const state = setup();
    vi.mocked(startApplicationRendererHost).mockResolvedValue(state.host);
    state.window.loadURL.mockRejectedValue(Object.assign(new Error('connection reset'), {
      code: 'ERR_CONNECTION_RESET',
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loading = loadPackagedRenderer(state.window, state.application, '/packaged/dist', state.onUrl);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      state.application.emit('before-quit');

      await expect(loading).resolves.toBe(false);
      expect(state.window.loadURL).toHaveBeenCalledOnce();
      expect(state.host.close).toHaveBeenCalledOnce();
      expect(state.window.webContents.listenerCount('did-navigate')).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
