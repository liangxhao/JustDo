import { EventEmitter } from 'node:events';

import { afterEach, expect, test, vi } from 'vitest';

import { AppInitializationIpc, INITIALIZATION_WINDOW_ARGUMENT } from '../../shared/app/initialization';
import { BrowserIpc, BrowserTabPresentation } from '../../shared/browser/browser';
import { SessionDirectoryIpc } from '../../shared/cowork/sessionDirectory';
import { AgentCliIntegrationIpc } from '../../shared/integrations/agentCliIntegration';
import { type ExtensionChangedEvent, ExtensionIpc } from '../../shared/plugins/extensions';
import { StorageDirectoryIpc } from '../../shared/storage/storageDirectory';

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
  await import('./index');
  const bridge = electronMocks.expose.mock.calls[0][1];

  expect(Object.keys(bridge.agentCli)).toEqual(['getStatus']);
  expect(bridge).not.toHaveProperty('multica');
  expect(electronMocks.invoke).not.toHaveBeenCalled();
  await bridge.agentCli.getStatus();
  expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(AgentCliIntegrationIpc.GetStatus);
});

test('exposes cleanup observation as a parameter-free status read without subscribing or mutating', async () => {
  await import('./index');
  const bridge = electronMocks.expose.mock.calls[0][1];
  expect(electronMocks.invoke).not.toHaveBeenCalled();

  await bridge.storageDirectory.cleanupStatus();

  expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(StorageDirectoryIpc.CleanupStatus);
  expect(electronMocks.on).not.toHaveBeenCalled();
});

test('keeps session directory, bounded summary reads and search snapshots on separate bridge calls', async () => {
  await import('./index');
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

    await import('./index');

    expect(electronMocks.expose).toHaveBeenCalledOnce();
    const [name, bridge] = electronMocks.expose.mock.calls[0];
    expect(name).toBe('electron');
    expect(bridge.initialization.isTransientWindow).toBe(transient);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
    await bridge.initialization.getState();
    expect(electronMocks.invoke).toHaveBeenCalledWith(AppInitializationIpc.GetState);
  },
);

async function preloadEvents() {
  const emitter = new EventEmitter();
  electronMocks.on.mockImplementation((channel, handler) => emitter.on(channel, handler));
  electronMocks.removeListener.mockImplementation((channel, handler) =>
    emitter.removeListener(channel, handler),
  );
  await import('./index');
  return { emitter, bridge: electronMocks.expose.mock.calls[0][1] };
}

async function extensionSubscriptions() {
  const { emitter, bridge } = await preloadEvents();
  const subscribe = bridge.extensions.onChanged as (
    callback: (event: ExtensionChangedEvent) => void,
  ) => () => void;
  const change = { extensionId: 'example-extension', enabled: false };
  return { emitter, subscribe, change };
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

const popup = {
  url: 'https://example.com/popup',
  openerGuestId: 7,
  presentation: BrowserTabPresentation.Background,
};
const page = { url: 'https://example.com/document.pdf', guestId: 7 };
const challenge = { id: 'auth-1', guestId: 7 };
const authRequest = { ...challenge, host: 'example.com', port: 443, realm: '', scheme: 'basic' };
const favicon = { ...page, faviconUrl: 'data:image/png;base64,AA==' };
const interaction = { sessionId: 'session-1', targetId: 'tab-1', busy: true };

test.each([
  ['onPanelOpenTab', BrowserIpc.PanelOpenTab, popup, popup],
  ['onPanelHttpAuthRequest', BrowserIpc.PanelHttpAuthRequest, authRequest, authRequest],
  [
    'onPanelHttpAuthDismissed', BrowserIpc.PanelHttpAuthDismissed,
    { ...challenge, username: 'sample', password: 'sample' }, challenge,
  ],
  ['onPanelPdfDetected', BrowserIpc.PanelPdfDetected, page, page],
  ['onPanelFaviconUpdated', BrowserIpc.PanelFaviconUpdated, favicon, favicon],
  ['onAgentInteractionState', BrowserIpc.AgentInteractionState, interaction, interaction],
] as const)('%s shares its IPC listener and cleans up after all browser consumers leave', async (
  method, channel, payload, expected,
) => {
  const { emitter, bridge } = await preloadEvents();
  const subscribe = bridge.browser[method] as (callback: (event: unknown) => void) => () => void;
  const callbacks = Array.from({ length: 12 }, () => vi.fn());
  const releases = callbacks.map(callback => subscribe(callback));
  expect(emitter.listenerCount(channel)).toBe(1);

  emitter.emit(channel, { sender: 'private IPC event' }, payload);
  for (const callback of callbacks) expect(callback).toHaveBeenCalledExactlyOnceWith(expected);

  releases[0]();
  emitter.emit(channel, {}, payload);
  expect(callbacks[0]).toHaveBeenCalledOnce();
  expect(callbacks[1]).toHaveBeenCalledTimes(2);

  for (const release of releases) release();
  expect(emitter.listenerCount(channel)).toBe(0);
});

test('drops malformed new-tab events before calling browser panels', async () => {
  const { emitter, bridge } = await preloadEvents();
  const callback = vi.fn();
  const release = bridge.browser.onPanelOpenTab(callback);

  emitter.emit(BrowserIpc.PanelOpenTab, {}, { ...popup, openerGuestId: '7' });

  expect(callback).not.toHaveBeenCalled();
  release();
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
