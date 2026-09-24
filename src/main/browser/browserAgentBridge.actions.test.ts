import fs from 'fs';
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

test('uses a nested act targetId to select the requested tab', async () => {
  const firstSendInputEvent = vi.fn();
  const secondSendInputEvent = vi.fn();
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/first',
    sendInputEvent: firstSendInputEvent,
  });
  electron.guests.set(8, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/second',
    sendInputEvent: secondSendInputEvent,
  });
  registerGuest(7, 'embedded-1');
  registerGuest(8, 'embedded-2');

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'press', key: 'Enter', targetId: 'embedded-2' },
    }),
  ).resolves.toMatchObject({
    details: { ok: true, targetId: 'embedded-2', pressed: 'Enter' },
  });
  expect(firstSendInputEvent).not.toHaveBeenCalled();
  expect(secondSendInputEvent).toHaveBeenCalledTimes(2);
});

test('rejects legacy flattened act parameters', async () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      kind: 'type',
      ref: 'e1',
      text: 'hello',
    }),
  ).rejects.toThrow('action=act does not accept top-level kind');

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      timeoutMs: 1_000,
      request: { kind: 'wait', timeMs: 10 },
    }),
  ).rejects.toThrow('action=act does not accept top-level timeoutMs');
});

test('waits for a started main-frame navigation to finish before returning fresh page state', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let loading = false;
  let currentUrl = 'https://example.com/old';
  const executeJavaScriptInIsolatedWorld = vi
    .fn()
    .mockImplementation((_worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code ?? '';
      if (code.includes("=== 'type') element.focus")) {
        return { x: 10, y: 10, disabled: false, editable: false };
      }
      return {
        title: 'New page',
        url: currentUrl,
        text: 'new content',
        elements: [],
      };
    });
  const sendInputEvent = vi.fn((event: { type?: string }) => {
    if (event.type !== 'mouseUp') return;
    loading = true;
    listeners.get('did-start-navigation')?.({}, currentUrl, false, true);
  });
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => currentUrl,
    getTitle: () => 'Page',
    isLoadingMainFrame: () => loading,
    executeJavaScriptInIsolatedWorld,
    sendInputEvent,
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    off: vi.fn(),
  });
  registerGuest(7);

  let settled = false;
  const pending = bridge
    .executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', selector: '#next' },
    })
    .finally(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(sendInputEvent).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(settled).toBe(false);

  currentUrl = 'https://example.com/new';
  loading = false;
  await expect(pending).resolves.toMatchObject({
    details: {
      url: 'https://example.com/new',
      pageState: expect.objectContaining({ url: 'https://example.com/new' }),
    },
  });
});

test('allows about:blank navigation but rejects every other non-http protocol', async () => {
  let currentUrl = 'https://example.com/';
  const loadURL = vi.fn(async (url: string) => {
    currentUrl = url;
  });
  const executeJavaScriptInIsolatedWorld = vi.fn().mockImplementation(() => ({
    title: '',
    url: currentUrl,
    text: '',
    elements: [],
  }));
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => '',
    getURL: () => currentUrl,
    loadURL,
    executeJavaScriptInIsolatedWorld,
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'navigate',
      targetUrl: 'about:blank',
    }),
  ).resolves.toMatchObject({
    details: { ok: true, targetId: 'embedded-1', url: 'about:blank' },
  });
  expect(loadURL).toHaveBeenCalledWith('about:blank');

  for (const targetUrl of [
    'about:srcdoc',
    'data:text/html,hello',
    'file:///tmp/example.html',
    'javascript:void(0)',
  ]) {
    await expect(
      bridge.executeCommand('justdo:session-1', { action: 'navigate', targetUrl }),
    ).rejects.toThrow(/http|https|about:blank/i);
  }
});

test('maps ControlOrMeta for trusted input and rejects unknown modifiers', async () => {
  const sendInputEvent = vi.fn();
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      x: 10,
      y: 10,
      disabled: false,
      editable: false,
    }),
    sendInputEvent,
  });
  registerGuest(7);

  await bridge.executeCommand('justdo:session-1', {
    action: 'act',
    request: { kind: 'click', selector: '#target', modifiers: ['ControlOrMeta'] },
  });
  expect(sendInputEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'mouseDown',
      modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
    }),
  );
  await bridge.executeCommand('justdo:session-1', {
    action: 'act',
    request: { kind: 'press', key: 'ControlOrMeta+A' },
  });
  expect(sendInputEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'keyDown',
      keyCode: 'A',
      modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
    }),
  );
  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', selector: '#target', modifiers: ['mystery'] },
    }),
  ).rejects.toThrow('Unsupported input modifier');
});

test('applies device user agent, viewport, orientation, and touch emulation together', async () => {
  const sendCommand = vi.fn().mockResolvedValue(undefined);
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      sendCommand,
    },
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'emulate',
      device: 'iPhone 13 landscape',
    }),
  ).resolves.toMatchObject({ ok: true, applied: ['device'] });

  expect(sendCommand).toHaveBeenCalledWith(
    'Emulation.setUserAgentOverride',
    expect.objectContaining({ userAgent: expect.stringContaining('iPhone OS 15_0') }),
  );
  expect(sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
    mobile: true,
    width: 750,
    height: 342,
    deviceScaleFactor: 3,
    screenWidth: 844,
    screenHeight: 390,
    screenOrientation: { angle: 90, type: 'landscapePrimary' },
  });
  expect(sendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', {
    enabled: true,
  });
});

test('rejects dialog handling when accept is omitted', async () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
  });
  registerGuest(7);

  await expect(bridge.executeCommand('justdo:session-1', { action: 'dialog' })).rejects.toThrow(
    'accept is required',
  );
});

test('expires an armed dialog response according to timeoutMs', async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendCommand = vi.fn().mockResolvedValue(undefined);
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
        listeners.set(event, listener),
      ),
      off: vi.fn(),
      sendCommand,
    },
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'dialog',
      accept: true,
      timeoutMs: 1_000,
    }),
  ).resolves.toMatchObject({ ok: true, armed: true });
  expect(sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentInteractionState, {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    profile: 'embedded',
    busy: true,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sendToRenderer).toHaveBeenLastCalledWith(BrowserIpc.AgentInteractionState, {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    profile: 'embedded',
    busy: false,
  });

  listeners.get('message')?.({}, 'Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Too late',
  });
  await Promise.resolve();

  expect(sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', expect.anything());
});

test('stops a batch before the next action when a dialog opens asynchronously', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let clickReleased = false;
  const sendInputEvent = vi.fn((event: { type?: string; keyCode?: string }) => {
    if (event.type === 'mouseUp' && !clickReleased) {
      clickReleased = true;
      setTimeout(() => {
        listeners.get('message')?.({}, 'Page.javascriptDialogOpening', {
          type: 'alert',
          message: 'Delayed dialog',
        });
      }, 10);
    }
  });
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    sendInputEvent,
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      x: 10,
      y: 20,
      disabled: false,
      editable: true,
    }),
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
        listeners.set(event, listener),
      ),
      off: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    },
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: {
        kind: 'batch',
        actions: [
          { kind: 'click', selector: '#open-dialog' },
          { kind: 'type', selector: '#should-not-run', text: 'no' },
        ],
      },
    }),
  ).resolves.toMatchObject({
    details: {
      blockedByDialog: true,
      browserState: {
        dialogs: { pending: [expect.objectContaining({ message: 'Delayed dialog' })] },
      },
    },
  });
  expect(sendInputEvent).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'char', keyCode: 'n' }),
  );
});

test('uses trusted CDP mouse input for drag actions', async () => {
  const sendCommand = vi.fn().mockResolvedValue(undefined);
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      start: { x: 10, y: 20 },
      end: { x: 110, y: 120 },
    }),
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      sendCommand,
    },
  });
  registerGuest(7);

  await bridge.executeCommand('justdo:session-1', {
    action: 'act',
    request: { kind: 'drag', startSelector: '#source', endSelector: '#target' },
  });

  expect(sendCommand).toHaveBeenCalledWith(
    'Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mousePressed', button: 'left' }),
  );
  expect(sendCommand).toHaveBeenCalledWith(
    'Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mouseReleased', x: 110, y: 120 }),
  );
});
