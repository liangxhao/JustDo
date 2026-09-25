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

import { BROWSER_AGENT_PANEL_TARGET_ID, BrowserIpc } from '../../shared/browser/browser';
import {
  BrowserInterventionIpc,
  type BrowserInterventionResult,
} from '../../shared/browser/browserIntervention';
import { BrowserRecordingChannel } from '../../shared/browser/browserRecording';
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

test('protects all tabs in a recording profile and ignores releases from a different recording', async () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  const loadURL = vi.fn().mockResolvedValue(undefined);
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    loadURL,
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      title: 'Example',
      url: 'https://example.com/next',
      text: '',
      elements: [],
    }),
  });
  registerGuest(7);
  const lease = electron.handlers.get(BrowserRecordingChannel.Lease)!;
  const request = {
    recordingId: 'recording-1',
    sessionId: 'session-1',
    profile: 'embedded',
    acquire: true,
  };
  expect(lease(trustedEvent(), request)).toBe(true);
  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'navigate',
      url: 'https://example.com/next',
    }),
  ).rejects.toThrow('recording');
  lease(trustedEvent(), { ...request, recordingId: 'stale-recording', acquire: false });
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'open', url: 'https://example.com/new' }),
  ).rejects.toThrow('recording');
  expect(loadURL).not.toHaveBeenCalled();
  lease(trustedEvent(), { ...request, acquire: false });
  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'navigate',
      url: 'https://example.com/next',
    }),
  ).resolves.toMatchObject({ details: { ok: true } });
  expect(loadURL).toHaveBeenCalled();
});

test.each(['destroyed', 'render-process-gone', 'did-start-navigation'])(
  'releases a recording lease when its owner emits %s',
  eventName => {
    bridge = new BrowserAgentBridge(vi.fn(), () => true);
    bridge.registerIpc();
    electron.guests.set(7, {
      id: 7,
      getType: () => 'webview',
      isDestroyed: () => false,
      session: electron.partition,
      hostWebContents: { id: 10 },
      getTitle: () => 'Example',
      getURL: () => 'https://example.com/',
    });
    registerGuest(7);
    const event = trustedEvent();
    const lease = electron.handlers.get(BrowserRecordingChannel.Lease)!;
    const request = {
      recordingId: 'first',
      sessionId: 'session-1',
      profile: 'embedded',
      acquire: true,
    };
    expect(lease(event, request)).toBe(true);
    expect(lease(event, { ...request, recordingId: 'next' })).toBe(false);
    expect(lease(trustedEvent(11), request)).toBe(false);
    lease(event, { ...request, sessionId: 'wrong-session', acquire: false });
    expect(lease(event, { ...request, recordingId: 'next' })).toBe(false);
    const release = event.sender.once.mock.calls.find(([name]) => name === eventName)?.[1];
    expect(release).toBeTypeOf('function');
    release();
    expect(lease(event, { ...request, recordingId: 'next' })).toBe(true);
  },
);

test('acknowledges a panel lock before lazily creating the first tab', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(
    sendToRenderer,
    () => true,
    () => null,
    true,
  );
  bridge.registerIpc();

  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'open',
    targetUrl: 'https://example.com/',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentInteractionState,
      expect.objectContaining({
        targetId: BROWSER_AGENT_PANEL_TARGET_ID,
        busy: true,
        operationId: expect.any(String),
      }),
    ),
  );
  expect(sendToRenderer).not.toHaveBeenCalledWith(BrowserIpc.AgentEnsureTab, expect.anything());
  const interaction = sendToRenderer.mock.calls.find(
    call =>
      call[0] === BrowserIpc.AgentInteractionState &&
      call[1]?.targetId === BROWSER_AGENT_PANEL_TARGET_ID &&
      call[1]?.busy === true,
  )?.[1] as { operationId: string };
  electron.handlers.get(BrowserIpc.AgentInteractionReady)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: BROWSER_AGENT_PANEL_TARGET_ID,
    profile: 'embedded',
    operationId: interaction.operationId,
  });

  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ sessionId: 'session-1', targetId: expect.any(String) }),
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
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    loadURL: vi.fn().mockResolvedValue(undefined),
  });
  registerGuest(7, targetId);

  await expect(pending).resolves.toMatchObject({ ok: true, targetId });
});

test('keeps a shared panel lock ready when the first concurrent caller is cancelled', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(
    sendToRenderer,
    () => true,
    () => null,
    true,
  );
  bridge.registerIpc();
  for (const [id, targetId] of [
    [7, 'embedded-1'],
    [8, 'embedded-2'],
  ] as const) {
    electron.guests.set(id, {
      id,
      getType: () => 'webview',
      isDestroyed: () => false,
      session: electron.partition,
      hostWebContents: { id: 10 },
      getTitle: () => targetId,
      getURL: () => `https://example.com/${targetId}`,
    });
    registerGuest(id, targetId);
  }
  const firstController = new AbortController();
  const first = bridge.executeCommand(
    'justdo:session-1',
    { action: 'focus', targetId: 'embedded-1' },
    firstController.signal,
  );
  const second = bridge.executeCommand('justdo:session-1', {
    action: 'focus',
    targetId: 'embedded-2',
  });
  await vi.waitFor(() =>
    expect(
      sendToRenderer.mock.calls.filter(
        call =>
          call[0] === BrowserIpc.AgentInteractionState &&
          call[1]?.targetId === BROWSER_AGENT_PANEL_TARGET_ID &&
          call[1]?.busy === true,
      ),
    ).toHaveLength(1),
  );
  expect(sendToRenderer).not.toHaveBeenCalledWith(BrowserIpc.AgentFocusTab, expect.anything());
  firstController.abort(new Error('cancel first'));
  await expect(first).rejects.toThrow('Browser request was cancelled');

  const interaction = sendToRenderer.mock.calls.find(
    call =>
      call[0] === BrowserIpc.AgentInteractionState &&
      call[1]?.targetId === BROWSER_AGENT_PANEL_TARGET_ID &&
      call[1]?.busy === true,
  )?.[1] as { operationId: string };
  electron.handlers.get(BrowserIpc.AgentInteractionReady)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: BROWSER_AGENT_PANEL_TARGET_ID,
    profile: 'embedded',
    operationId: interaction.operationId,
  });

  await expect(second).resolves.toMatchObject({ ok: true, targetId: 'embedded-2' });
  expect(sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentFocusTab, {
    sessionId: 'session-1',
    targetId: 'embedded-2',
  });
});

test('rejects a cross-profile panel operation while the user annotates this session', async () => {
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(
    sendToRenderer,
    () => true,
    () => null,
    true,
  );
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Embedded',
    getURL: () => 'https://example.com/',
  });
  registerGuest(7);
  electron.handlers.get(BrowserIpc.UserInteractionState)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    profile: 'embedded',
    busy: true,
  });

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'importprofile',
      into: 'imported',
    }),
  ).rejects.toThrow('user is annotating');
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    BrowserIpc.AgentInteractionState,
    expect.objectContaining({ targetId: BROWSER_AGENT_PANEL_TARGET_ID, busy: true }),
  );
});

test('rejects page mutations while the user is annotating and resumes afterward', async () => {
  const sendInputEvent = vi.fn();
  const executeJavaScriptInIsolatedWorld = vi.fn(
    (_worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code ?? '';
      if (code.includes('globalThis.__justdoBrowserAgentState =')) {
        return {
          title: 'Example',
          url: 'https://example.com/',
          text: '',
          ariaNext: 1,
          elements: [],
        };
      }
      return { x: 10, y: 20, disabled: false, editable: false };
    },
  );
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld,
    sendInputEvent,
  });
  registerGuest(7);
  const interactionState = {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    busy: true,
  };
  electron.handlers.get(BrowserIpc.UserInteractionState)?.(trustedEvent(), interactionState);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', selector: '#save' },
    }),
  ).rejects.toThrow('user is annotating');
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'snapshot' }),
  ).resolves.toMatchObject({ details: { ok: true } });
  expect(sendInputEvent).not.toHaveBeenCalled();

  electron.handlers.get(BrowserIpc.UserInteractionState)?.(trustedEvent(), {
    ...interactionState,
    busy: false,
  });
  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', selector: '#save' },
    }),
  ).resolves.toMatchObject({ details: { clicked: '#save' } });
});

test('rechecks the user annotation lock after a mutating command leaves the queue', async () => {
  let releaseSnapshot!: (value: unknown) => void;
  const snapshotResult = new Promise(resolve => {
    releaseSnapshot = resolve;
  });
  const executeJavaScriptInIsolatedWorld = vi.fn().mockReturnValue(snapshotResult);
  const loadURL = vi.fn().mockResolvedValue(undefined);
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld,
    loadURL,
  });
  registerGuest(7);

  const first = bridge.executeCommand('justdo:session-1', { action: 'snapshot' });
  await vi.waitFor(() => expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalled());
  const queuedNavigation = bridge.executeCommand('justdo:session-1', {
    action: 'navigate',
    targetUrl: 'https://example.com/next',
  });
  electron.handlers.get(BrowserIpc.UserInteractionState)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    busy: true,
  });
  releaseSnapshot({
    title: 'Example',
    url: 'https://example.com/',
    text: '',
    crossOriginFrames: [],
    elements: [],
  });

  await expect(first).resolves.toMatchObject({ details: { ok: true } });
  await expect(queuedNavigation).rejects.toThrow('user is annotating');
  expect(loadURL).not.toHaveBeenCalled();
});

test('locks the live page while navigation is in progress', async () => {
  let finishNavigation!: () => void;
  const loadURL = vi.fn().mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishNavigation = resolve;
      }),
  );
  const sendToRenderer = vi.fn();
  bridge = new BrowserAgentBridge(
    sendToRenderer,
    () => true,
    () => null,
    true,
  );
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    loadURL,
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      title: 'Next',
      url: 'https://example.com/next',
      text: '',
      crossOriginFrames: [],
      elements: [],
    }),
  });
  registerGuest(7);

  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'navigate',
    targetUrl: 'https://example.com/next',
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentInteractionState,
      expect.objectContaining({
        sessionId: 'session-1',
        targetId: BROWSER_AGENT_PANEL_TARGET_ID,
        profile: 'embedded',
        busy: true,
        operationId: expect.any(String),
      }),
    ),
  );
  expect(loadURL).not.toHaveBeenCalled();
  const panelInteraction = sendToRenderer.mock.calls.find(
    call =>
      call[0] === BrowserIpc.AgentInteractionState &&
      call[1]?.busy === true &&
      call[1]?.targetId === BROWSER_AGENT_PANEL_TARGET_ID,
  )?.[1] as { operationId: string };
  electron.handlers.get(BrowserIpc.AgentInteractionReady)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: BROWSER_AGENT_PANEL_TARGET_ID,
    profile: 'embedded',
    operationId: panelInteraction.operationId,
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentInteractionState,
      expect.objectContaining({
        sessionId: 'session-1',
        targetId: 'embedded-1',
        profile: 'embedded',
        busy: true,
        operationId: expect.any(String),
      }),
    ),
  );
  const tabInteraction = sendToRenderer.mock.calls.find(
    call =>
      call[0] === BrowserIpc.AgentInteractionState &&
      call[1]?.busy === true &&
      call[1]?.targetId === 'embedded-1',
  )?.[1] as { operationId: string };
  electron.handlers.get(BrowserIpc.AgentInteractionReady)?.(trustedEvent(), {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    profile: 'embedded',
    operationId: tabInteraction.operationId,
  });
  await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce());
  finishNavigation();
  await expect(pending).resolves.toMatchObject({ details: { ok: true } });
  expect(sendToRenderer).toHaveBeenCalledWith(
    BrowserIpc.AgentInteractionState,
    expect.objectContaining({
      sessionId: 'session-1',
      targetId: 'embedded-1',
      profile: 'embedded',
      busy: false,
      operationId: tabInteraction.operationId,
    }),
  );
  expect(sendToRenderer).toHaveBeenLastCalledWith(
    BrowserIpc.AgentInteractionState,
    expect.objectContaining({
      sessionId: 'session-1',
      targetId: BROWSER_AGENT_PANEL_TARGET_ID,
      profile: 'embedded',
      busy: false,
      operationId: panelInteraction.operationId,
    }),
  );
});

test('manual handoff waits for navigation to settle and rejects stale or foreign releases', async () => {
  let finish!: () => void;
  const navigation = new Promise<void>(resolve => {
    finish = resolve;
  });
  const loadURL = vi.fn(() => navigation);
  const stop = vi.fn();
  bridge = new BrowserAgentBridge(vi.fn(), id => id === 10);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    loadURL,
    stop,
  });
  registerGuest(7);
  const invoke = (action: string, token?: string, sender = 10) =>
    electron.handlers.get(BrowserInterventionIpc)!(trustedEvent(sender), {
      action,
      token,
      sessionId: 'session-1',
      targetId: 'embedded-1',
      profile: 'embedded',
    }) as unknown as BrowserInterventionResult;
  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'navigate',
    url: 'https://example.com/next',
  });
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce());
  expect(invoke('begin', undefined, 99).success).toBe(false);
  const hold = invoke('begin');
  if (!hold.success || !hold.value) throw new Error('missing hold');
  await rejected;
  expect(stop).toHaveBeenCalledOnce();
  const token = hold.value.token;
  expect(invoke('confirmStop', token)).toMatchObject({ value: { phase: 'stopping' } });
  expect(invoke('resume', token)).toEqual({ success: false, error: 'busy' });
  await expect(bridge.executeCommand('justdo:session-1', { action: 'tabs' })).rejects.toThrow(
    'manually operating',
  );
  finish();
  await vi.waitFor(() => expect(invoke('read')).toMatchObject({ value: { phase: 'manual' } }));
  expect(invoke('resume', 'old-token')).toEqual({ success: false, error: 'stale' });
  expect(invoke('resume', token)).toMatchObject({ value: { phase: 'resuming' } });
  expect(invoke('resume', token)).toEqual({ success: false, error: 'busy' });
  expect(invoke('complete', token)).toEqual({ success: true, value: null });
});

test('the owning renderer can recover a hold after its last guest closes', () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
  });
  registerGuest(7);
  const invoke = (action: string, token?: string, sender = 10, targetId = 'embedded-1') =>
    electron.handlers.get(BrowserInterventionIpc)!(trustedEvent(sender), {
      action,
      token,
      sessionId: 'session-1',
      targetId,
      profile: 'embedded',
    }) as unknown as BrowserInterventionResult;
  const first = invoke('begin');
  if (!first.success || !first.value) throw new Error('missing hold');
  electron.guests.delete(7);
  const target = BROWSER_AGENT_PANEL_TARGET_ID;
  expect(invoke('read', undefined, 10, target)).toMatchObject({ value: first.value });
  for (const action of ['read', 'begin', 'confirmStop', 'resume', 'complete']) {
    expect(invoke(action, first.value.token, 99, target)).toEqual({
      success: false,
      error: 'unavailable',
    });
  }
  const renewed = invoke('begin', undefined, 10, target);
  if (!renewed.success || !renewed.value) throw new Error('missing renewed hold');
  expect(invoke('confirmStop', first.value.token, 10, target)).toEqual({
    success: false,
    error: 'stale',
  });
  const token = renewed.value.token;
  expect(invoke('confirmStop', token, 10, target)).toMatchObject({ value: { phase: 'manual' } });
  expect(invoke('resume', token, 10, target)).toMatchObject({ value: { phase: 'resuming' } });
  expect(invoke('complete', token, 10, target)).toEqual({ success: true, value: null });
  expect(invoke('read', undefined, 10, target)).toEqual({ success: true, value: null });
  expect(invoke('begin', undefined, 10, target)).toEqual({ success: false, error: 'unavailable' });
});

test('a replacement window can recover a hold only after its former owner is destroyed', () => {
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  let ownerDestroyed = false;
  electron.guests.set(10, { isDestroyed: () => ownerDestroyed });
  electron.guests.set(99, { isDestroyed: () => false });
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
  });
  registerGuest(7);
  const invoke = (action: string, sender = 10, targetId = 'embedded-1') =>
    electron.handlers.get(BrowserInterventionIpc)!(trustedEvent(sender), {
      action,
      sessionId: 'session-1',
      targetId,
      profile: 'embedded',
    }) as unknown as BrowserInterventionResult;
  const hold = invoke('begin');
  electron.guests.set(8, {
    ...electron.guests.get(7),
    id: 8,
    hostWebContents: { id: 99 },
  });
  electron.handlers.get(BrowserIpc.AgentRegisterTab)!(trustedEvent(99), {
    sessionId: 'session-1',
    targetId: 'replacement',
    webContentsId: 8,
    profile: 'embedded',
  });
  expect(invoke('read', 99, 'replacement')).toEqual({ success: false, error: 'unavailable' });
  ownerDestroyed = true;
  expect(invoke('read', 99, BROWSER_AGENT_PANEL_TARGET_ID)).toEqual({
    success: false,
    error: 'unavailable',
  });
  expect(invoke('read', 99, 'replacement')).toEqual(hold);
  expect(invoke('read', 10)).toEqual({ success: false, error: 'unavailable' });
});

test('cleanup failure cannot retain a finished browser operation in the intervention drain', async () => {
  let finish!: () => void;
  const navigation = new Promise<void>(resolve => {
    finish = resolve;
  });
  const loadURL = vi.fn(() => navigation);
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle: () => 'Example',
    getURL: () => 'https://example.com/',
    loadURL,
    stop: vi.fn(),
  });
  registerGuest(7);
  const invoke = (action: string, token?: string) =>
    electron.handlers.get(BrowserInterventionIpc)!(trustedEvent(), {
      action,
      token,
      sessionId: 'session-1',
      targetId: 'embedded-1',
      profile: 'embedded',
    }) as unknown as BrowserInterventionResult;
  const pending = bridge.executeCommand('justdo:session-1', {
    action: 'navigate',
    url: 'https://example.com/next',
  });
  const rejection = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce());
  const cleanup = vi
    .spyOn(
      bridge as unknown as { clearInterventionActions: () => void },
      'clearInterventionActions',
    )
    .mockImplementation(() => {
      throw new Error('guest cleanup failed');
    });
  expect(invoke('begin').success).toBe(false);
  await rejection;
  const hold = invoke('read');
  if (!hold.success || !hold.value) throw new Error('missing hold');
  invoke('confirmStop', hold.value.token);
  finish();
  await vi.waitFor(() => expect(invoke('read')).toMatchObject({ value: { phase: 'manual' } }));
  cleanup.mockRestore();
});

test('cancels an in-flight page action without committing its result', async () => {
  let finishNavigation!: () => void;
  const navigation = new Promise<void>(resolve => {
    finishNavigation = resolve;
  });
  const getTitle = vi.fn(() => 'Should not be returned');
  const stop = vi.fn();
  const loadURL = vi.fn(() => navigation);
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle,
    getURL: () => 'https://example.com/',
    loadURL,
    stop,
  });
  registerGuest(7);
  const controller = new AbortController();

  const pending = bridge.executeCommand(
    'justdo:session-1',
    { action: 'navigate', url: 'https://example.com/next' },
    controller.signal,
  );
  await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(stop).toHaveBeenCalledOnce();
  finishNavigation();
  await Promise.resolve();
  expect(getTitle).not.toHaveBeenCalled();
});

test('stops a slow trusted-input sequence promptly after cancellation', async () => {
  const sendInputEvent = vi.fn();
  const appliedTypeScripts: string[] = [];
  const executeJavaScriptInIsolatedWorld = vi
    .fn()
    .mockImplementation((_worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code ?? '';
      if (code.includes('__justdoBrowserAgentState =')) {
        return {
          title: 'Example',
          url: 'https://example.com/',
          text: '',
          elements: [{ ref: 'e1', tag: 'input', editable: true }],
        };
      }
      if (code.includes('const rect = element.getBoundingClientRect')) {
        return { x: 10, y: 10, disabled: false, editable: true };
      }
      if (code.includes("new view.InputEvent('input'")) {
        appliedTypeScripts.push(code);
        return true;
      }
      throw new Error('Unexpected browser script.');
    });
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld,
    sendInputEvent,
    stop: vi.fn(),
  });
  registerGuest(7);
  await bridge.executeCommand('justdo:session-1', {
    action: 'snapshot',
  });
  const controller = new AbortController();
  const pending = bridge.executeCommand(
    'justdo:session-1',
    {
      action: 'act',
      request: { kind: 'type', ref: 'e1', text: 'hello', slowly: true, delayMs: 1_000 },
    },
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(appliedTypeScripts.some(code => code.includes('const value = "h"'))).toBe(true),
  );

  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(sendInputEvent).not.toHaveBeenCalled();
  expect(appliedTypeScripts.some(code => code.includes('const value = "he"'))).toBe(false);
});

test.each([
  {
    request: { kind: 'clickCoords', x: 10, y: 20, delayMs: 1_000 },
    down: 'mouseDown',
    up: 'mouseUp',
  },
  {
    request: { kind: 'press', key: 'Enter', delayMs: 1_000 },
    down: 'keyDown',
    up: 'keyUp',
  },
])(
  'releases trusted input when a delayed $down action is cancelled',
  async ({ request, down, up }) => {
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
      sendInputEvent,
      stop: vi.fn(),
    });
    registerGuest(7);
    const controller = new AbortController();
    const pending = bridge.executeCommand(
      'justdo:session-1',
      { action: 'act', request },
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: down })),
    );

    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() =>
      expect(sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: up })),
    );
    const downCalls = sendInputEvent.mock.calls.filter(call => call[0]?.type === down);
    const upCalls = sendInputEvent.mock.calls.filter(call => call[0]?.type === up);
    expect(downCalls).toHaveLength(1);
    expect(upCalls).toHaveLength(1);
    expect(sendInputEvent.mock.calls.indexOf(downCalls[0]!)).toBeLessThan(
      sendInputEvent.mock.calls.indexOf(upCalls[0]!),
    );
    if (up === 'mouseUp') {
      expect(upCalls[0]?.[0]).toMatchObject({ x: 10, y: 20, button: 'left' });
    } else {
      expect(upCalls[0]?.[0]).toMatchObject({ keyCode: 'Enter' });
    }
  },
);

test('releases a trusted drag when it is cancelled after mouse press', async () => {
  const sendCommand = vi.fn().mockResolvedValue(undefined);
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    stop: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      start: { x: 10, y: 20 },
      end: { x: 100, y: 120 },
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
  const controller = new AbortController();
  const pending = bridge.executeCommand(
    'justdo:session-1',
    {
      action: 'act',
      request: { kind: 'drag', startSelector: '#source', endSelector: '#target' },
    },
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' }),
    ),
  );

  controller.abort();

  await expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() =>
    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseReleased',
        button: 'left',
        buttons: 0,
      }),
    ),
  );
  const mouseCommands = sendCommand.mock.calls.filter(
    call => call[0] === 'Input.dispatchMouseEvent',
  );
  const pressedIndex = mouseCommands.findIndex(call => call[1]?.type === 'mousePressed');
  const released = mouseCommands.filter(call => call[1]?.type === 'mouseReleased');
  expect(released).toHaveLength(1);
  expect(pressedIndex).toBeGreaterThanOrEqual(0);
  expect(mouseCommands.indexOf(released[0]!)).toBeGreaterThan(pressedIndex);
  const lastDraggedPoint = mouseCommands
    .slice(0, mouseCommands.indexOf(released[0]!))
    .findLast(call => call[1]?.type === 'mouseMoved' && call[1]?.buttons === 1);
  const expectedReleasePoint = lastDraggedPoint?.[1] ?? mouseCommands[pressedIndex]?.[1];
  expect(released[0]?.[1]).toEqual(
    expect.objectContaining({ x: expectedReleasePoint?.x, y: expectedReleasePoint?.y }),
  );
});

test('removes a cancelled tab waiter before a delayed guest registers', async () => {
  const sendToRenderer = vi.fn();
  const getTitle = vi.fn(() => 'Late tab');
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();
  const controller = new AbortController();
  const pending = bridge.executeCommand(
    'justdo:session-1',
    { action: 'navigate', url: 'https://example.com/' },
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      BrowserIpc.AgentEnsureTab,
      expect.objectContaining({ sessionId: 'session-1', targetId: expect.any(String) }),
    ),
  );

  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getTitle,
    getURL: () => 'https://example.com/',
  });
  registerGuest(7);
  await Promise.resolve();
  expect(getTitle).not.toHaveBeenCalled();
});

test('terminates a timed-out evaluation and keeps the tab queue usable', async () => {
  let attached = false;
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 12 };
    if (method === 'Runtime.evaluate') throw new Error('Script execution timed out');
    return undefined;
  });
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    stop: vi.fn(),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      sendCommand,
    },
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      title: 'Recovered',
      url: 'https://example.com/',
      text: '',
      elements: [],
    }),
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'evaluate', fn: '() => { while (true) {} }', timeoutMs: 1_000 },
    }),
  ).rejects.toThrow('timed out');
  expect(sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution');

  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'snapshot' }),
  ).resolves.toMatchObject({ details: { ok: true, targetId: 'embedded-1' } });
});

test('terminates an evaluation immediately when the tool request is aborted', async () => {
  let attached = false;
  let rejectEvaluation: ((error: Error) => void) | undefined;
  const evaluation = new Promise<never>((_resolve, reject) => {
    rejectEvaluation = reject;
  });
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 12 };
    if (method === 'Runtime.evaluate') return evaluation;
    if (method === 'Runtime.terminateExecution') {
      rejectEvaluation?.(new Error('Execution was terminated'));
    }
    return undefined;
  });
  bridge = new BrowserAgentBridge(vi.fn(), () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    stop: vi.fn(),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      sendCommand,
    },
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      title: 'Recovered',
      url: 'https://example.com/',
      text: '',
      elements: [],
    }),
  });
  registerGuest(7);
  const controller = new AbortController();
  const pending = bridge.executeCommand(
    'justdo:session-1',
    { action: 'act', request: { kind: 'evaluate', fn: 'async () => await new Promise(() => {})' } },
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything()),
  );

  controller.abort();

  await expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith('Runtime.terminateExecution'));
  await expect(
    bridge.executeCommand('justdo:session-1', { action: 'snapshot' }),
  ).resolves.toMatchObject({ details: { ok: true } });
});

test('does not let a long-lived action request hold the interaction lock until timeout', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendToRenderer = vi.fn();
  const stop = vi.fn();
  const sendInputEvent = vi.fn((event: { type?: string }) => {
    if (event.type !== 'mouseUp') return;
    listeners.get('message')?.({}, 'Network.requestWillBeSent', {
      requestId: 'live-events',
      type: 'EventSource',
      request: { url: 'https://example.com/events', method: 'GET' },
    });
  });
  bridge = new BrowserAgentBridge(sendToRenderer, () => true);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    sendInputEvent,
    stop,
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      x: 10,
      y: 20,
      disabled: false,
      editable: false,
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

  const startedAt = Date.now();
  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', selector: '#subscribe' },
    }),
  ).resolves.toMatchObject({ details: { clicked: '#subscribe' } });

  expect(Date.now() - startedAt).toBeLessThan(2_500);
  expect(stop).not.toHaveBeenCalled();
  expect(sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentInteractionState, {
    sessionId: 'session-1',
    targetId: 'embedded-1',
    profile: 'embedded',
    busy: false,
  });
});

test('reports a dialog opened by an act as blocked browser state', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendInputEvent = vi.fn((event: { type?: string }) => {
    if (event.type === 'mouseUp') {
      listeners.get('message')?.({}, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue?',
      });
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
      editable: false,
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
      request: { kind: 'click', selector: '#confirm' },
    }),
  ).resolves.toMatchObject({
    details: {
      blockedByDialog: true,
      browserState: {
        dialogs: { pending: [expect.objectContaining({ type: 'confirm', message: 'Continue?' })] },
      },
    },
  });
});
