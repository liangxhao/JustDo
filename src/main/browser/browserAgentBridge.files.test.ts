import fs from 'fs';
import { JSDOM } from 'jsdom';
import os from 'os';
import path from 'path';
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
import { claimBrowserAgentDownload } from './browserAgentDownloadCoordinator';

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

test('rejects mutually exclusive direct upload selectors', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-upload-args-'));
  temporaryRoots.push(temporaryRoot);
  fs.writeFileSync(path.join(temporaryRoot, 'upload.txt'), 'hello');
  bridge = new BrowserAgentBridge(
    vi.fn(),
    () => true,
    () => temporaryRoot,
  );
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

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'upload',
      ref: 'e1',
      element: 'input[type=file]',
      paths: ['upload.txt'],
    }),
  ).rejects.toThrow('ref cannot be combined with inputRef/element');
  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'upload',
      inputRef: 'e1',
      element: 'input[type=file]',
      paths: ['upload.txt'],
    }),
  ).rejects.toThrow('inputRef and element are mutually exclusive');
});

test('uploads to a file input selected inside an open shadow root', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-shadow-upload-'));
  temporaryRoots.push(temporaryRoot);
  const uploadPath = path.join(temporaryRoot, 'upload.txt');
  fs.writeFileSync(uploadPath, 'hello');
  const dom = new JSDOM('<!doctype html><x-upload></x-upload>', {
    runScripts: 'outside-only',
    url: 'https://example.com/',
  });
  const shadow = dom.window.document.querySelector('x-upload')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input class="picker" type="file">';
  const input = shadow.querySelector('input')!;
  const executeJavaScriptInIsolatedWorld = vi.fn(
    (_worldId: number, scripts: Array<{ code: string }>) => dom.window.eval(scripts[0]!.code),
  );
  let attached = false;
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'DOM.performSearch') {
      expect(params).toMatchObject({ includeUserAgentShadowDOM: true });
      expect(input.getAttribute('data-justdo-upload-marker')).toMatch(/^justdo-upload-/u);
      return { searchId: 'shadow-search', resultCount: 1 };
    }
    if (method === 'DOM.getSearchResults') return { nodeIds: [73] };
    return undefined;
  });
  bridge = new BrowserAgentBridge(
    vi.fn(),
    () => true,
    () => temporaryRoot,
  );
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    executeJavaScriptInIsolatedWorld,
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
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'upload',
      element: 'input.picker',
      paths: ['upload.txt'],
    }),
  ).resolves.toMatchObject({ ok: true, paths: ['upload.txt'] });
  expect(sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
    files: [fs.realpathSync(uploadPath)],
    nodeId: 73,
  });
  expect(input.hasAttribute('data-justdo-upload-marker')).toBe(false);
  dom.window.close();
});

test('rejects an output path outside the workspace without creating its parent directory', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-agent-'));
  temporaryRoots.push(temporaryRoot);
  const workspace = path.join(temporaryRoot, 'workspace');
  const outsideDirectory = path.join(temporaryRoot, 'outside', 'nested');
  fs.mkdirSync(workspace);

  bridge = new BrowserAgentBridge(
    vi.fn(),
    () => true,
    () => workspace,
  );
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    printToPDF: vi.fn().mockResolvedValue(Buffer.from('pdf')),
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'pdf',
      path: path.join('..', 'outside', 'nested', 'report.pdf'),
    }),
  ).rejects.toThrow('inside the task workspace');
  expect(fs.existsSync(outsideDirectory)).toBe(false);
});

test('disarms a paths-only upload after its bounded wait expires', async () => {
  vi.useFakeTimers();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-upload-'));
  temporaryRoots.push(temporaryRoot);
  const uploadPath = path.join(temporaryRoot, 'upload.txt');
  fs.writeFileSync(uploadPath, 'hello');
  let attached = false;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendCommand = vi.fn().mockResolvedValue(undefined);
  const sendToRenderer = vi.fn();
  const guestDebugger = {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      listeners.set(event, listener),
    ),
    off: vi.fn(),
    sendCommand,
  };
  try {
    bridge = new BrowserAgentBridge(
      sendToRenderer,
      () => true,
      () => temporaryRoot,
    );
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

    await bridge.executeCommand('justdo:session-1', {
      action: 'upload',
      paths: ['upload.txt'],
    });
    expect(sendCommand).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', {
      enabled: true,
    });
    expect(sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentInteractionState, {
      sessionId: 'session-1',
      targetId: 'embedded-1',
      profile: 'embedded',
      busy: true,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendCommand).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', {
      enabled: false,
    });
    expect(sendToRenderer).toHaveBeenLastCalledWith(BrowserIpc.AgentInteractionState, {
      sessionId: 'session-1',
      targetId: 'embedded-1',
      profile: 'embedded',
      busy: false,
    });
    sendCommand.mockClear();
    listeners.get('message')?.({}, 'Page.fileChooserOpened', { backendNodeId: 42 });
    await Promise.resolve();
    expect(sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
  } finally {
    vi.useRealTimers();
  }
});

test('captures downloads triggered by normal act clicks in the task workspace', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-act-download-'));
  temporaryRoots.push(temporaryRoot);
  const download = {
    cancel: vi.fn(),
    getFilename: () => 'report.pdf',
    getURL: () => 'https://example.com/report.pdf?access_token=secret',
    getReceivedBytes: () => 12,
    getTotalBytes: () => 12,
    getState: () => 'progressing',
  } as unknown as Electron.DownloadItem;
  let guest!: Record<string, unknown>;
  const sendInputEvent = vi.fn((event: { type?: string }) => {
    if (event.type !== 'mouseUp') return;
    const claim = claimBrowserAgentDownload(
      electron.partition as unknown as Electron.Session,
      download,
      guest as unknown as Electron.WebContents,
    );
    expect(claim).not.toBeNull();
    claim?.settle(download, 'completed');
  });
  bridge = new BrowserAgentBridge(
    vi.fn(),
    () => true,
    () => temporaryRoot,
  );
  bridge.registerIpc();
  guest = {
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
  };
  electron.guests.set(7, guest);
  registerGuest(7);

  const result = (await bridge.executeCommand('justdo:session-1', {
    action: 'act',
    request: { kind: 'click', selector: '#download' },
  })) as { details: { downloads: Array<{ url: string; path: string }> } };

  expect(result.details.downloads[0]?.url).toBe(
    'https://example.com/report.pdf?access_token=%5BREDACTED%5D',
  );
  expect(result.details.downloads[0]?.path.startsWith(temporaryRoot)).toBe(true);
});

test('tracks the action network lifecycle until a delayed download response starts', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-slow-download-'));
  temporaryRoots.push(temporaryRoot);
  const download = {
    cancel: vi.fn(),
    getFilename: () => 'slow.pdf',
    getURL: () => 'https://example.com/slow.pdf',
    getReceivedBytes: () => 4,
    getTotalBytes: () => 4,
    getState: () => 'progressing',
  } as unknown as Electron.DownloadItem;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let guest!: Record<string, unknown>;
  const sendInputEvent = vi.fn((event: { type?: string }) => {
    if (event.type !== 'mouseUp') return;
    listeners.get('message')?.({}, 'Network.requestWillBeSent', {
      requestId: 'slow-download',
      type: 'Document',
      request: { url: 'https://example.com/slow.pdf', method: 'GET' },
    });
    setTimeout(() => {
      const claim = claimBrowserAgentDownload(
        electron.partition as unknown as Electron.Session,
        download,
        guest as unknown as Electron.WebContents,
      );
      claim?.settle(download, 'completed');
      listeners.get('message')?.({}, 'Network.loadingFailed', {
        requestId: 'slow-download',
        errorText: 'net::ERR_ABORTED',
      });
    }, 500);
  });
  bridge = new BrowserAgentBridge(
    vi.fn(),
    () => true,
    () => temporaryRoot,
  );
  bridge.registerIpc();
  guest = {
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
  };
  electron.guests.set(7, guest);
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'act',
      request: { kind: 'click', selector: '#slow-download' },
    }),
  ).resolves.toMatchObject({
    details: {
      downloads: [expect.objectContaining({ suggestedFilename: 'slow.pdf' })],
    },
  });
});

test.each(['download', 'waitfordownload'] as const)(
  'keeps the default %s capture armed for the native 120 second timeout',
  async action => {
    vi.useFakeTimers();
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'justdo-browser-download-timeout-'),
    );
    temporaryRoots.push(temporaryRoot);
    const sendInputEvent = vi.fn();
    const executeJavaScriptInIsolatedWorld = vi
      .fn()
      .mockImplementation((_worldId: number, scripts: Array<{ code: string }>) => {
        const code = scripts[0]?.code ?? '';
        if (code.includes('__justdoBrowserAgentState =')) {
          return {
            title: 'Example',
            url: 'https://example.com/',
            text: '',
            elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'Download', href: '' }],
          };
        }
        if (code.includes('const rect = element.getBoundingClientRect')) {
          return { x: 10, y: 10, disabled: false, editable: false };
        }
        throw new Error('Unexpected browser script.');
      });
    bridge = new BrowserAgentBridge(
      vi.fn(),
      () => true,
      () => temporaryRoot,
    );
    bridge.registerIpc();
    const guest = {
      id: 7,
      getType: () => 'webview',
      isDestroyed: () => false,
      session: electron.partition,
      hostWebContents: { id: 10 },
      getTitle: () => 'Example',
      getURL: () => 'https://example.com/',
      executeJavaScriptInIsolatedWorld,
      sendInputEvent,
    };
    electron.guests.set(7, guest);
    registerGuest(7);
    if (action === 'download') {
      await bridge.executeCommand('justdo:session-1', { action: 'snapshot' });
    }

    const pending = bridge.executeCommand('justdo:session-1', {
      action,
      ...(action === 'download' ? { path: 'report.pdf', ref: 'e1' } : {}),
    });
    await vi.advanceTimersByTimeAsync(119_999);
    const item = {
      cancel: vi.fn(),
      getFilename: () => 'report.pdf',
      getState: () => 'progressing',
      getURL: () => 'https://example.com/report.pdf',
      getReceivedBytes: () => 12,
      getTotalBytes: () => 12,
    } as unknown as Electron.DownloadItem;
    const claim = claimBrowserAgentDownload(
      electron.partition as unknown as Electron.Session,
      item,
      guest as unknown as Electron.WebContents,
    );
    expect(claim).not.toBeNull();
    claim?.settle(item, 'completed');

    await expect(pending).resolves.toMatchObject({
      details: {
        ok: true,
        download: expect.objectContaining({ suggestedFilename: 'report.pdf' }),
      },
    });
  },
);

test('does not create directories through a workspace junction', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-output-workspace-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-output-outside-'));
  temporaryRoots.push(workspace, outside);
  const junction = path.join(workspace, 'linked');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  bridge = new BrowserAgentBridge(
    vi.fn(),
    () => true,
    () => workspace,
  );
  bridge.registerIpc();
  electron.guests.set(7, {
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    printToPDF: vi.fn().mockResolvedValue(Buffer.from('pdf')),
  });
  registerGuest(7);

  await expect(
    bridge.executeCommand('justdo:session-1', {
      action: 'pdf',
      path: 'linked/new/report.pdf',
    }),
  ).rejects.toThrow('inside the task workspace');
  expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
});
