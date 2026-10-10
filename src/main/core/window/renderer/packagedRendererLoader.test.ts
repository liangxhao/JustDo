import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startApplicationRendererHost } from './applicationRendererHost';
import { loadPackagedRenderer } from './packagedRendererLoader';

vi.mock('./applicationRendererHost', () => ({ startApplicationRendererHost: vi.fn() }));

const setup = () => ({
  window: Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(() => Promise.resolve()),
  }),
  application: new EventEmitter(),
  host: {
    origin: 'http://127.0.0.1:45001',
    url: 'http://127.0.0.1:45001/index.html',
    close: vi.fn(() => Promise.resolve()),
  },
  onUrl: vi.fn(),
});

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

  it('waits for preference preparation and does not start a host after closure during preparation', async () => {
    const state = setup();
    let finish!: () => void;
    const preparing = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    const loading = loadPackagedRenderer(
      state.window,
      state.application,
      '/packaged/dist',
      state.onUrl,
      preparing,
    );
    expect(preparing).toHaveBeenCalledOnce();
    expect(startApplicationRendererHost).not.toHaveBeenCalled();
    state.window.emit('closed');
    finish();
    await loading;
    expect(startApplicationRendererHost).not.toHaveBeenCalled();
    expect(state.window.loadURL).not.toHaveBeenCalled();
    expect(state.application.listenerCount('before-quit')).toBe(0);
  });
});
