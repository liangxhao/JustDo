import { EventEmitter } from 'node:events';

import { afterEach, expect, test, vi } from 'vitest';

import { AppInitializationIpc, INITIALIZATION_WINDOW_ARGUMENT } from '../shared/app/initialization';
import { SessionDirectoryIpc } from '../shared/cowork/sessionDirectory';
import { AgentCliIntegrationIpc } from '../shared/integrations/agentCliIntegration';
import { type ExtensionChangedEvent, ExtensionIpc } from '../shared/plugins/extensions';

const electronMocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.expose },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
  webUtils: {},
}));

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.clearAllMocks();
  electronMocks.on.mockReset();
  electronMocks.removeListener.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('exposes CLI status without access switches or a client-specific configuration API', async () => {
  await import('./preload');
  const bridge = electronMocks.expose.mock.calls[0][1];

  expect(Object.keys(bridge.agentCli)).toEqual(['getStatus']);
  expect(bridge).not.toHaveProperty('multica');
  expect(electronMocks.invoke).not.toHaveBeenCalled();
  await bridge.agentCli.getStatus();
  expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(AgentCliIntegrationIpc.GetStatus);
});

test('keeps session directory, bounded summary reads and search snapshots on separate bridge calls', async () => {
  await import('./preload');
  const bridge = electronMocks.expose.mock.calls[0][1];

  await bridge.cowork.listSessionDirectory('main');
  await bridge.cowork.readSessionSummaries(['one', 'two']);
  await bridge.cowork.listSessionSearchSummaries();

  expect(electronMocks.invoke.mock.calls).toEqual([
    [SessionDirectoryIpc.List, 'main'],
    [SessionDirectoryIpc.ReadSummaries, ['one', 'two']],
    [SessionDirectoryIpc.SearchSummaries],
  ]);
});

test.each([
  { args: [], transient: false },
  { args: [INITIALIZATION_WINDOW_ARGUMENT], transient: true },
  { args: [`${INITIALIZATION_WINDOW_ARGUMENT}=true`], transient: false },
  { args: [`prefix${INITIALIZATION_WINDOW_ARGUMENT}`], transient: false },
])(
  'exposes exact initialization window context without requiring a ready Store: $args',
  async ({ args, transient }) => {
    process.argv = [originalArgv[0], 'preload-test', ...args];

    await import('./preload');

    expect(electronMocks.expose).toHaveBeenCalledOnce();
    const [name, bridge] = electronMocks.expose.mock.calls[0];
    expect(name).toBe('electron');
    expect(bridge.initialization.isTransientWindow).toBe(transient);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
    await bridge.initialization.getState();
    expect(electronMocks.invoke).toHaveBeenCalledWith(AppInitializationIpc.GetState);
  },
);

async function extensionSubscriptions() {
  const emitter = new EventEmitter();
  electronMocks.on.mockImplementation((channel, handler) => emitter.on(channel, handler));
  electronMocks.removeListener.mockImplementation((channel, handler) =>
    emitter.removeListener(channel, handler),
  );
  await import('./preload');
  const bridge = electronMocks.expose.mock.calls[0][1] as {
    extensions: { onChanged: (callback: (event: ExtensionChangedEvent) => void) => () => void };
  };
  const change = { extensionId: 'example-extension', enabled: false };
  return { emitter, subscribe: bridge.extensions.onChanged, change };
}

test('shares one IPC listener across many cards and releases it after the last subscriber', async () => {
  const { emitter, subscribe, change } = await extensionSubscriptions();
  const callbacks = Array.from({ length: 24 }, () => vi.fn());
  const releases = callbacks.map(callback => subscribe(callback));

  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(1);
  expect(electronMocks.on).toHaveBeenCalledOnce();
  emitter.emit(ExtensionIpc.Changed, { sender: 'private IPC event' }, change);
  for (const callback of callbacks) expect(callback).toHaveBeenCalledExactlyOnceWith(change);

  releases[0]();
  releases[0]();
  emitter.emit(ExtensionIpc.Changed, {}, change);
  expect(callbacks[0]).toHaveBeenCalledOnce();
  expect(callbacks[1]).toHaveBeenCalledTimes(2);
  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(1);

  for (const release of releases) release();
  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(0);
  expect(electronMocks.removeListener).toHaveBeenCalledOnce();

  const next = vi.fn();
  const release = subscribe(next);
  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(1);
  expect(next).not.toHaveBeenCalled();
  releases[0]();
  emitter.emit(ExtensionIpc.Changed, {}, change);
  expect(next).toHaveBeenCalledExactlyOnceWith(change);
  release();
  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(0);
});

test('keeps repeated subscriptions of the same callback independent', async () => {
  const { emitter, subscribe, change } = await extensionSubscriptions();
  const callback = vi.fn();
  const first = subscribe(callback);
  const second = subscribe(callback);

  emitter.emit(ExtensionIpc.Changed, {}, change);
  expect(callback).toHaveBeenCalledTimes(2);
  first();
  first();
  emitter.emit(ExtensionIpc.Changed, {}, change);
  expect(callback).toHaveBeenCalledTimes(3);
  second();
  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(0);
});

test('isolates callback failures and respects subscription changes during delivery', async () => {
  const { emitter, subscribe, change } = await extensionSubscriptions();
  const error = new Error('subscriber failed');
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const removed = vi.fn();
  const added = vi.fn();
  let remove = () => {};
  let add = () => {};
  const first = subscribe(() => {
    remove();
    add = subscribe(added);
    throw error;
  });
  remove = subscribe(removed);
  const last = vi.fn();
  const releaseLast = subscribe(last);

  emitter.emit(ExtensionIpc.Changed, {}, change);

  expect(log).toHaveBeenCalledWith('[ExtensionsPreload] Change listener failed:', error);
  expect(removed).not.toHaveBeenCalled();
  expect(added).not.toHaveBeenCalled();
  expect(last).toHaveBeenCalledExactlyOnceWith(change);
  first();
  emitter.emit(ExtensionIpc.Changed, {}, change);
  expect(added).toHaveBeenCalledExactlyOnceWith(change);
  add();
  releaseLast();
  expect(emitter.listenerCount(ExtensionIpc.Changed)).toBe(0);
});
