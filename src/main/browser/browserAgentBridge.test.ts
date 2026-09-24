import fs from 'fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => void>(),
  guests: new Map<number, Record<string, unknown>>(),
  partition: { id: 'browser-partition', storagePath: 'C:\\profiles\\embedded' },
  partitions: new Map<string, { id: string; storagePath: string }>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, value: unknown) => void) =>
      electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel),
    on: (channel: string, handler: (event: unknown, value: unknown) => void) =>
      electron.handlers.set(channel, handler),
  },
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => {
      const image = {
        getSize: () => ({ width: 1, height: 1 }),
        resize: () => image,
        toJPEG: () => buffer,
        toPNG: () => buffer,
      };
      return image;
    },
  },
  session: {
    fromPartition: (partition: string) => electron.partitions.get(partition) ?? electron.partition,
  },
  webContents: { fromId: (id: number) => electron.guests.get(id) ?? null },
}));

import { BrowserIpc } from '../../shared/browser/browser';
import { BrowserAgentBridge } from './browserAgentBridge';

let bridge: BrowserAgentBridge | null = null;

const temporaryRoots: string[] = [];

const trustedEvent = (senderId = 10) => {
  const mainFrame = { processId: 20, routingId: 30 };
  return {
    sender: {
      id: senderId,
      getType: () => 'window',
      mainFrame,
      once: vi.fn(),
      removeListener: vi.fn(),
    },
    // Electron can return different WebFrameMain wrappers for the same
    // underlying frame, so the bridge must compare stable frame identifiers.
    senderFrame: { processId: 20, routingId: 30 },
  };
};

const registerGuest = (
  webContentsId: number,
  targetId = 'embedded-1',
  profile: 'embedded' | 'imported' = 'embedded',
): void => {
  const guest = electron.guests.get(webContentsId);
  if (
    guest &&
    (profile === 'imported' || !(guest.session as { storagePath?: string })?.storagePath)
  ) {
    guest.session =
      electron.partitions.get(
        profile === 'imported' ? 'persist:justdo-browser-imported' : 'persist:justdo-browser',
      ) ?? electron.partition;
  }
  if (guest && !guest.debugger) {
    guest.debugger = {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
  }
  if (guest && !guest.focus) guest.focus = vi.fn();
  electron.handlers.get(BrowserIpc.AgentRegisterTab)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId,
    webContentsId,
    profile,
  });
};

beforeEach(() => {
  electron.handlers.clear();
  electron.guests.clear();
  electron.partitions.clear();
  electron.partitions.set('persist:justdo-browser', electron.partition);
  electron.partitions.set('persist:justdo-browser-imported', {
    id: 'browser-imported-partition',
    storagePath: 'C:\\profiles\\imported',
  });
});

afterEach(async () => {
  try {
    await bridge?.stop();
  } finally {
    vi.useRealTimers();
    bridge = null;
    for (const temporaryRoot of temporaryRoots.splice(0)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test('keeps lifecycle and tab inspection actions lazy', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();

  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'status' }),
  ).resolves.toMatchObject({ running: false, tabCount: 0 });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'doctor' }),
  ).resolves.toMatchObject({
    checks: expect.arrayContaining([
      expect.objectContaining({ id: 'embedded-page', status: 'info' }),
    ]),
    status: expect.objectContaining({ profile: 'embedded', running: false }),
  });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'start' }),
  ).resolves.toMatchObject({ running: true });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'tabs' }),
  ).resolves.toMatchObject({ running: true, tabs: [], tabCount: 0 });

  expect(sendToRenderer).not.toHaveBeenCalled();
});

test('opens, labels, resolves, and closes a distinct internal tab', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();

  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'open',
    targetUrl: 'https://example.com/report',
    label: 'report',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({
        sessionId: 'session-1',
        targetId: expect.any(String),
        label: 'report',
      }),
    ),
  );
  const targetId = (
    sendToRenderer.mock.calls.find(call => call[0] === BrowserIpc.AgentEnsureTab)?.[1] as {
      targetId: string;
    }
  ).targetId;
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Report',
    getURL: () => 'https://example.com/report',
    loadURL: vi.fn().mockResolvedValue(undefined),
  });
  registerGuest(7, targetId);

  await expect(pending).resolves.toMatchObject({
    ok: true,
    suggestedTargetId: 'report',
    tabId: 't1',
    label: 'report',
    targetId,
  });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'close', targetId: 'report' }),
  ).resolves.toEqual({ ok: true, targetId });
  expect(sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentCloseTab, {
    sessionId: 'session-1',
    targetId,
  });
});

test('lists and focuses only registered live guests while redacting sensitive URLs', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, senderId => senderId === 10);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () =>
      'https://alice:secret@example.com/?client_secret=secret&x-amz-signature=signed&key=plain&AWSAccessKeyId=legacy&view=all#/callback?access_token=hidden',
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('agent:main:justdo:session-1', { action: 'tabs' }),
  ).resolves.toMatchObject({
    ok: true,
    running: true,
    tabs: [
      {
        targetId: 'embedded-1',
        title: 'Example',
        url: 'https://example.com/?client_secret=%5BREDACTED%5D&x-amz-signature=%5BREDACTED%5D&key=%5BREDACTED%5D&AWSAccessKeyId=%5BREDACTED%5D&view=all#/callback?access_token=%5BREDACTED%5D',
      },
    ],
  });
  await bridge.executeCommand('agent:main:justdo:session-1', {
    action: 'focus',
    targetId: 'embedded-1',
  });
  expect(sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentFocusTab, {
    sessionId: 'session-1',
    targetId: 'embedded-1',
  });
});

test('keeps imported-profile tabs isolated from the default embedded profile', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();

  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'open',
    profile: 'imported',
    targetUrl: 'https://example.com/imported',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ profile: 'imported' }),
    ),
  );
  const targetId = (
    sendToRenderer.mock.calls.find(call => call[0] === BrowserIpc.AgentEnsureTab)?.[1] as {
      targetId: string;
    }
  ).targetId;
  electron.guests.set(8, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Imported',
    getURL: () => 'https://example.com/imported',
    loadURL: vi.fn().mockResolvedValue(undefined),
  });
  registerGuest(8, targetId, 'imported');
  await pending;

  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'tabs' }),
  ).resolves.toMatchObject({ profile: 'embedded', tabs: [] });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'tabs', profile: 'imported' }),
  ).resolves.toMatchObject({
    profile: 'imported',
    tabs: [expect.objectContaining({ targetId })],
  });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'profiles' }),
  ).resolves.toMatchObject({
    profiles: expect.arrayContaining([
      expect.objectContaining({ name: 'embedded', isRemote: false }),
      expect.objectContaining({ name: 'imported', isRemote: false }),
    ]),
  });
});

test('rejects registrations from a subframe or an untrusted renderer', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, senderId => senderId === 10);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
  });
  const subframeEvent = trustedEvent();
  subframeEvent.senderFrame = { processId: 20, routingId: 31 };
  electron.handlers.get(BrowserIpc.AgentRegisterTab)?.(subframeEvent, {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    webContentsId: 7,
    profile: 'embedded',
  });
  electron.handlers.get(BrowserIpc.AgentRegisterTab)?.(trustedEvent(11), {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    webContentsId: 7,
    profile: 'embedded',
  });

  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'navigate',
    url: 'https://example.com/',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ sessionId: 'session-1', targetId: expect.any(String) }),
    ),
  );
  await bridge.stop();
  await expect(pending).rejects.toThrow('stopping');
});

test('rejects a profile registration whose guest uses another partition', async () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partitions.get('persist:justdo-browser-imported'),
    hostWebContents: { id: 10 },
  });

  registerGuest(7, 'embedded-1', 'embedded');

  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'tabs' }),
  ).resolves.toMatchObject({ tabs: [], tabCount: 0 });
});

test('replaces a destroyed guest before executing the next command', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, senderId => senderId === 10);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => true,
    session: electron.partition,
    hostWebContents: { id: 10 },
  });
  registerGuest(7);

  const responsePromise = bridge.executeCommand('agent:main:justdo:session-1', {
    action: 'navigate',
    url: 'https://example.com/replacement',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ sessionId: 'session-1', targetId: expect.any(String) }),
    ),
  );
  const requestedTargetId = (
    sendToRenderer.mock.calls.find(call => call[0] === BrowserIpc.AgentEnsureTab)?.[1] as {
      targetId: string;
    }
  ).targetId;
  electron.guests.set(8, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Replacement',
    getURL: () => 'https://example.com/replacement',
    loadURL: vi.fn().mockResolvedValue(undefined),
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      title: 'Replacement',
      url: 'https://example.com/replacement',
      text: '',
      elements: [],
    }),
  });
  registerGuest(8, requestedTargetId);

  await expect(responsePromise).resolves.toMatchObject({
    details: expect.objectContaining({ targetId: requestedTargetId }),
  });
});

test('opens a missing embedded tab at the requested URL and accepts its live guest', async () => {
  const sendToRenderer = vi.fn();
  const loadURL = vi.fn().mockResolvedValue(undefined);
  bridge = new BrowserAgentBridge(sendToRenderer, senderId => senderId === 10);
  bridge.registerIpc();

  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'navigate',
    url: 'https://example.com/path',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({
        sessionId: 'session-1',
        targetId: expect.any(String),
      }),
    ),
  );
  const requestedTargetId = (
    sendToRenderer.mock.calls.find(call => call[0] === BrowserIpc.AgentEnsureTab)?.[1] as {
      targetId: string;
    }
  ).targetId;
  electron.guests.set(8, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: {
      id: 'equivalent-browser-partition-wrapper',
      storagePath: electron.partition.storagePath,
    },
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/path',
    loadURL,
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      title: 'Example',
      url: 'https://example.com/path',
      text: '',
      elements: [],
    }),
  });
  registerGuest(8, requestedTargetId);

  await expect(pending).resolves.toMatchObject({
    details: expect.objectContaining({
      targetId: requestedTargetId,
      title: 'Example',
      url: 'https://example.com/path',
    }),
  });
  expect(loadURL).toHaveBeenCalledWith('https://example.com/path');
});

test('sanitizes sensitive URLs in browser errors', async () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    stop: vi.fn(),
    loadURL: () =>
      Promise.reject(
        new Error(
          'Navigation failed: https://example.com/callback?client_secret=secret#/done?access_token=hidden',
        ),
      ),
  });
  registerGuest(7);

  const error = await bridge
    .executeCommand('justdo:session-1', {
      action: 'navigate',
      url: 'https://example.com/callback',
    })
    .catch(candidate => candidate as Error);
  expect(error.message).toContain('%5BREDACTED%5D');
  expect(error.message).not.toContain('=secret');
  expect(error.message).not.toContain('=hidden');
});

test('allows a label to be reused after the user manually unregisters its tab', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();

  const firstOpen = bridge.executeCommand('justdo:session-1', {
    action: 'open',
    targetUrl: 'https://example.com/first',
    label: 'report',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ label: 'report' }),
    ),
  );
  const firstTargetId = (
    sendToRenderer.mock.calls.find(call => call[0] === BrowserIpc.AgentEnsureTab)?.[1] as {
      targetId: string;
    }
  ).targetId;
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'First',
    getURL: () => 'https://example.com/first',
    loadURL: vi.fn().mockResolvedValue(undefined),
  });
  registerGuest(7, firstTargetId);
  await expect(firstOpen).resolves.toMatchObject({ label: 'report' });

  electron.handlers.get(BrowserIpc.AgentUnregisterTab)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: firstTargetId,
  });
  sendToRenderer.mockClear();

  const secondOpen = bridge.executeCommand('justdo:session-1', {
    action: 'open',
    targetUrl: 'https://example.com/second',
    label: 'report',
  });
  void secondOpen.catch((): void => undefined);
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ label: 'report' }),
    ),
  );
  const secondTargetId = (
    sendToRenderer.mock.calls.find(call => call[0] === BrowserIpc.AgentEnsureTab)?.[1] as {
      targetId: string;
    }
  ).targetId;
  electron.guests.set(8, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Second',
    getURL: () => 'https://example.com/second',
    loadURL: vi.fn().mockResolvedValue(undefined),
  });
  registerGuest(8, secondTargetId);

  await expect(secondOpen).resolves.toMatchObject({
    label: 'report',
    targetId: secondTargetId,
  });
  expect(secondTargetId).not.toBe(firstTargetId);
});

test('keeps the active tab stable and selects the adjacent tab when closing it', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();
  for (const [webContentsId, targetId] of [
    [7, 'embedded-a'],
    [8, 'embedded-b'],
    [9, 'embedded-c'],
  ] as const) {
    electron.guests.set(webContentsId, {
      getType: () => 'webview',
      isDestroyed: () => false,
      session: electron.partition,
      hostWebContents: { id: 10 },
      getTitle: () => targetId,
      getURL: () => `https://example.com/${targetId}`,
    });
    registerGuest(webContentsId, targetId);
  }

  await bridge.executeCommand('justdo:session-1', {
    action: 'focus',
    targetId: 'embedded-c',
  });
  await bridge.executeCommand('justdo:session-1', {
    action: 'close',
    targetId: 'embedded-b',
  });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'close' }),
  ).resolves.toMatchObject({ targetId: 'embedded-c' });

  registerGuest(8, 'embedded-b');
  registerGuest(9, 'embedded-c');
  await bridge.executeCommand('justdo:session-1', {
    action: 'focus',
    targetId: 'embedded-b',
  });
  await bridge.executeCommand('justdo:session-1', {
    action: 'close',
    targetId: 'embedded-b',
  });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'close' }),
  ).resolves.toMatchObject({ targetId: 'embedded-c' });
});

test('discovers, names, and clicks a control inside an open shadow root', async () => {
  const dom = new JSDOM('<!doctype html><title>Shadow page</title><x-panel></x-panel>', {
    runScripts: 'outside-only',
    url: 'https://example.com/',
  });
  const { window } = dom;
  const host = window.document.querySelector('x-panel')!;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<label for="email">Email address</label><input id="email"><span id="save-label">Save from label</span><button aria-label="Wrong" aria-labelledby="save-label">Ignored</button><input type="submit" value="Search">';
  const button = shadow.querySelector('button')!;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
  });
  window.Element.prototype.getBoundingClientRect = () =>
    ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 44,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    }) as DOMRect;
  window.Element.prototype.scrollIntoView = vi.fn();
  window.document.elementFromPoint = () => button;
  const executeJavaScriptInIsolatedWorld = vi.fn(
    (_worldId: number, scripts: Array<{ code: string }>) => window.eval(scripts[0]!.code),
  );
  const sendInputEvent = vi.fn();
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld,
    sendInputEvent,
  });
  registerGuest(7);

  const snapshot = (await bridge.executeCommand('justdo:session-1', {
    action: 'snapshot',
    interactive: true,
  })) as { content: Array<{ text: string }> };
  expect(snapshot.content[0]?.text).toContain('textbox "Email address" [ref=e1]');
  expect(snapshot.content[0]?.text).toContain('button "Save from label" [ref=e2]');
  expect(snapshot.content[0]?.text).toContain('button "Search" [ref=e3]');

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', ref: 'e2' },
    }),
  ).resolves.toMatchObject({ details: { clicked: 'e2' } });
  expect(sendInputEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'mouseDown', x: 60, y: 32 }),
  );
  dom.window.close();
});

test('reattaches and re-enables debugger domains after DevTools releases the tab', async () => {
  let attached = false;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const attach = vi.fn(() => {
    attached = true;
  });
  const sendCommand = vi.fn().mockResolvedValue(undefined);
  const guestDebugger = {
    isAttached: () => attached,
    attach,
    detach: vi.fn(() => {
      attached = false;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      listeners.set(event, listener),
    ),
    off: vi.fn(),
    sendCommand,
  };
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    debugger: guestDebugger,
  });
  registerGuest(7);
  await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith('Network.enable'));

  attached = false;
  listeners.get('detach')?.();
  sendCommand.mockClear();
  await bridge.executeCommand('justdo:session-1', { action: 'requests' });

  expect(attach).toHaveBeenCalledTimes(2);
  expect(sendCommand).toHaveBeenCalledWith('Network.enable');
  expect(sendCommand).toHaveBeenCalledWith('Runtime.enable');
  expect(sendCommand).toHaveBeenCalledWith('Page.enable');
});
