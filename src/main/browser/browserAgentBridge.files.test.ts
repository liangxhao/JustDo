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
import { claimBrowserAgentDownload } from './downloads/browserAgentDownloadCoordinator';

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

test('returns a JavaScript dialog without waiting for a blocked renderer evaluation', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let attached = false;
  const sendCommand = vi.fn(async () => undefined);
  bridge = new BrowserAgentBridge(vi.fn(), () => true, () => os.tmpdir());
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7, getType: () => 'webview', isDestroyed: () => false,
    session: electron.partition, hostWebContents: { id: 10 },
    getURL: () => 'https://example.com/',
    debugger: {
      isAttached: () => attached, attach: () => { attached = true; }, detach: vi.fn(),
      on: (name: string, callback: (...args: unknown[]) => void) => listeners.set(name, callback),
      off: vi.fn(), sendCommand,
    },
  });
  registerGuest(7);
  const execute = vi.spyOn(bridge as unknown as { executeOnGuest(): Promise<unknown> }, 'executeOnGuest');
  execute.mockImplementation(async () => {
    listeners.get('message')!({}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
    return { details: { blockedByDialog: true }, content: [] };
  });
  const result = await bridge.executeCommand('justdo:session-1', { action: 'act', request: { kind: 'click', selector: '#confirm' } });
  expect(result).toMatchObject({ details: { blockedByDialog: true } });
  expect(sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything());
});

test('does not assign a child debugger session input through the root debugger', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-chooser-session-'));
  temporaryRoots.push(workspace);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'fixture');
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let attached = false;
  const sendCommand = vi.fn(async () => undefined);
  bridge = new BrowserAgentBridge(vi.fn(), () => true, () => workspace);
  bridge.registerIpc();
  electron.guests.set(7, {
    id: 7, getType: () => 'webview', isDestroyed: () => false,
    session: electron.partition, hostWebContents: { id: 10 }, getURL: () => 'https://example.com/',
    debugger: {
      isAttached: () => attached, attach: () => { attached = true; }, detach: vi.fn(),
      on: (name: string, callback: (...args: unknown[]) => void) => listeners.set(name, callback),
      off: vi.fn(), sendCommand,
    },
  });
  registerGuest(7);
  await bridge.executeCommand('justdo:session-1', { action: 'upload', paths: ['file.txt'] });
  listeners.get('message')!({}, 'Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' }, 'child-session');
  await new Promise(resolve => setImmediate(resolve));
  expect(sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
  await expect(bridge.executeCommand('justdo:session-1', { action: 'errors' })).resolves.toMatchObject({ details: { errorCount: 1 } });
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
  ).resolves.toMatchObject({ ok: true, armed: false, completed: true, paths: ['upload.txt'] });
  expect(sendCommand).toHaveBeenCalledWith('DOM.enable');
  expect(sendCommand).toHaveBeenCalledWith('DOM.getDocument', { depth: 0, pierce: true });
  expect(sendCommand.mock.calls.findIndex(([method]) => method === 'DOM.enable')).toBeLessThan(
    sendCommand.mock.calls.findIndex(([method]) => method === 'DOM.getDocument'),
  );
  expect(sendCommand.mock.calls.findIndex(([method]) => method === 'DOM.getDocument')).toBeLessThan(
    sendCommand.mock.calls.findIndex(([method]) => method === 'DOM.performSearch'),
  );
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

test('exports PDFs to the shared task artifact directory when no path is specified', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-default-pdf-'));
  temporaryRoots.push(workspace);
  const pdf = Buffer.from('pdf');
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
    printToPDF: vi.fn().mockResolvedValue(pdf),
  });
  registerGuest(7);

  const result = (await bridge.executeCommand('justdo:session-1', { action: 'pdf' })) as {
    details: { path: string };
  };

  expect(path.dirname(result.details.path)).toBe(
    path.join(fs.realpathSync(workspace), '.agent-tasks', 'browser-artifacts'),
  );
  expect(fs.readFileSync(result.details.path)).toEqual(pdf);
  expect(fs.existsSync(path.join(workspace, '.justdo-tasks'))).toBe(false);
});

test('does not write a PDF that finishes rendering after cancellation', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cancelled-pdf-'));
  temporaryRoots.push(workspace);
  let finishPdf!: (pdf: Buffer) => void;
  const printToPDF = vi.fn(
    () =>
      new Promise<Buffer>(resolve => {
        finishPdf = resolve;
      }),
  );
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
    printToPDF,
  });
  registerGuest(7);
  const controller = new AbortController();
  const pending = bridge.executeCommand(
    'justdo:session-1',
    {
      action: 'pdf',
      path: 'cancelled.pdf',
    },
    controller.signal,
  );
  const cancelled = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(printToPDF).toHaveBeenCalled());

  controller.abort(new Error('cancelled'));
  await cancelled;
  finishPdf(Buffer.from('late-pdf'));
  await new Promise<void>(resolve => setImmediate(resolve));

  expect(fs.existsSync(path.join(workspace, 'cancelled.pdf'))).toBe(false);
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
      id: 7,
      getType: () => 'webview',
      isDestroyed: () => false,
      session: electron.partition,
      hostWebContents: { id: 10 },
      getURL: () => 'https://example.com/',
      debugger: guestDebugger,
    });
    registerGuest(7);

    const prepared = await bridge.executeCommand('justdo:session-1', {
      action: 'upload',
      paths: ['upload.txt'],
    });
    expect(prepared).toMatchObject({ ok: true, armed: true, completed: false, timeoutMs: 30_000 });
    expect(prepared).toHaveProperty('message', expect.stringContaining('no file has been selected yet'));
    expect(sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
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

const createUrlDownloadFixture = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-url-download-'));
  temporaryRoots.push(workspace);
  bridge = new BrowserAgentBridge(vi.fn(), () => true, () => workspace);
  bridge.registerIpc();
  const guest = {
    id: 7,
    getType: () => 'webview',
    isDestroyed: () => false,
    session: electron.partition,
    hostWebContents: { id: 10 },
    getURL: () => 'https://example.test/search',
    downloadURL: vi.fn(),
    loadURL: vi.fn(),
    sendInputEvent: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue({
      x: 10,
      y: 20,
      disabled: false,
      editable: false,
    }),
  };
  electron.guests.set(7, guest);
  registerGuest(7);
  const item = {
    cancel: vi.fn(),
    getFilename: () => 'photo.jpg',
    getURL: () => 'https://example.test/photo.jpg?access_token=secret',
    getMimeType: () => 'image/jpeg',
    getReceivedBytes: () => 12,
    getTotalBytes: () => 12,
    getState: () => 'progressing',
  } as unknown as Electron.DownloadItem;
  const claim = () => claimBrowserAgentDownload(
    electron.partition as unknown as Electron.Session,
    item,
    guest as unknown as Electron.WebContents,
  );
  return { workspace, guest, item, claim };
};

test('downloads an observed image URL through the current guest without navigating', async () => {
  const f = createUrlDownloadFixture();
  const pending = bridge!.executeCommand('justdo:session-1', {
    action: 'download',
    targetId: 'embedded-1',
    url: ' https://example.test/photo.jpg?access_token=secret ',
    path: 'downloads/风景.jpg',
  });
  await vi.waitFor(() => expect(f.guest.downloadURL).toHaveBeenCalledWith(
    'https://example.test/photo.jpg?access_token=secret',
  ));
  const claim = f.claim();
  expect(claim?.savePath).toBe(path.join(fs.realpathSync(f.workspace), 'downloads', '风景.jpg'));
  claim?.settle(f.item, 'completed');

  await expect(pending).resolves.toMatchObject({
    details: {
      ok: true,
      targetId: 'embedded-1',
      download: {
        state: 'completed',
        path: claim?.savePath,
        url: 'https://example.test/photo.jpg?access_token=%5BREDACTED%5D',
        mimeType: 'image/jpeg',
        receivedBytes: 12,
        totalBytes: 12,
      },
    },
  });
  const result = await pending as {
    content: Array<{ type: string; text: string }>;
    details: { download: Record<string, unknown> };
  };
  expect(result.content[0]?.text).toContain(JSON.stringify(result.details.download, null, 2));
  expect(f.guest.loadURL).not.toHaveBeenCalled();
});

test('reports native MIME and an unknown total size without inferring from the output extension', async () => {
  const f = createUrlDownloadFixture();
  f.item.getMimeType = () => 'text/html';
  f.item.getTotalBytes = () => 0;
  const pending = bridge!.executeCommand('justdo:session-1', {
    action: 'download',
    url: 'https://example.test/photo.jpg',
    path: 'photo.jpg',
  });
  await vi.waitFor(() => expect(f.guest.downloadURL).toHaveBeenCalledOnce());
  f.claim()?.settle(f.item, 'completed');

  await expect(pending).resolves.toMatchObject({
    details: { ok: true, download: {
      state: 'completed', mimeType: 'text/html', receivedBytes: 12, totalBytes: 0,
    } },
  });
});

test('rejects missing, ambiguous and unsafe download triggers before creating output directories', async () => {
  const f = createUrlDownloadFixture();
  const invalidTriggers = [
    {},
    { url: ' ', ref: ' ' },
    { ref: 42 },
    { url: 'https://example.test/photo.jpg', ref: 'e1' },
    { url: 'file:///C:/photo.html' },
    { url: 'data:image/png;base64,AAAA' },
    { url: 'https://user:password@example.test/photo.jpg' },
    { url: 'http://169.254.169.254/latest/meta-data/' },
  ];
  for (const trigger of invalidTriggers) {
    await expect(bridge!.executeCommand('justdo:session-1', {
      action: 'download',
      path: 'downloads/photo.jpg',
      ...trigger,
    })).rejects.toThrow();
  }
  expect(f.guest.downloadURL).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.workspace, 'downloads'))).toBe(false);
  expect(f.claim()).toBeNull();
});

test.each(['cancelled', 'interrupted'] as const)(
  'reports a %s URL download as a tool failure without a saved path',
  async state => {
    const f = createUrlDownloadFixture();
    const pending = bridge!.executeCommand('justdo:session-1', {
      action: 'download',
      url: 'https://example.test/photo.jpg',
      path: 'downloads/photo.jpg',
    });
    await vi.waitFor(() => expect(f.guest.downloadURL).toHaveBeenCalledOnce());
    const claim = f.claim();
    expect(claim?.savePath).toBeTruthy();
    fs.writeFileSync(claim!.savePath!, 'partial');
    claim?.settle(f.item, state);

    const result = await pending as { details: { download: Record<string, unknown> } };
    expect(result).toMatchObject({ isError: true, details: { ok: false, download: { state } } });
    expect(result.details.download).not.toHaveProperty('path');
    expect(fs.existsSync(claim!.savePath!)).toBe(false);
  },
);

test('does not overwrite an existing file when downloading a URL', async () => {
  const f = createUrlDownloadFixture();
  const outputPath = path.join(f.workspace, 'photo.jpg');
  fs.writeFileSync(outputPath, 'existing');

  await expect(bridge!.executeCommand('justdo:session-1', {
    action: 'download',
    url: 'https://example.test/photo.jpg',
    path: 'photo.jpg',
  })).rejects.toThrow('already exists');
  expect(f.guest.downloadURL).not.toHaveBeenCalled();
  expect(fs.readFileSync(outputPath, 'utf8')).toBe('existing');
});

test('cancels an in-flight URL download and rejects late download claims', async () => {
  const f = createUrlDownloadFixture();
  const controller = new AbortController();
  const pending = bridge!.executeCommand('justdo:session-1', {
    action: 'download',
    url: 'https://example.test/photo.jpg',
    path: 'photo.jpg',
  }, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.guest.downloadURL).toHaveBeenCalledOnce());
  const claim = f.claim();
  expect(claim?.savePath).toBeTruthy();
  fs.writeFileSync(claim!.savePath!, 'partial');
  controller.abort();

  await rejected;
  expect(f.item.cancel).toHaveBeenCalledOnce();
  expect(fs.existsSync(claim!.savePath!)).toBe(false);
  expect(f.claim()).toBeNull();
});

test('captures downloads triggered by normal act clicks in the task workspace', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-act-download-'));
  temporaryRoots.push(temporaryRoot);
  const download = {
    cancel: vi.fn(),
    getFilename: () => 'report.pdf',
    getURL: () => 'https://example.com/report.pdf?access_token=secret',
    getMimeType: () => 'application/pdf',
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
  })) as {
    content: Array<{ type: string; text: string }>;
    details: { downloads: Array<{ url: string; path: string }> };
  };

  expect(result.details.downloads[0]?.url).toBe(
    'https://example.com/report.pdf?access_token=%5BREDACTED%5D',
  );
  expect(path.dirname(result.details.downloads[0]!.path)).toBe(
    path.join(fs.realpathSync(temporaryRoot), '.agent-tasks', 'browser-artifacts'),
  );
  expect(result.details.downloads[0]).toMatchObject({
    state: 'completed', mimeType: 'application/pdf', receivedBytes: 12, totalBytes: 12,
  });
  expect(result.content).toContainEqual({
    type: 'text',
    text: expect.stringContaining(JSON.stringify({ downloads: result.details.downloads }, null, 2)),
  });
});

test('preserves a dispatched batch and completed files when another automatic download fails', async () => {
  const f = createUrlDownloadFixture();
  const interrupted = {
    ...f.item,
    getFilename: () => 'broken.csv',
    getMimeType: () => 'text/csv',
    getReceivedBytes: () => 3,
    getTotalBytes: () => 0,
  };
  const paths: string[] = [];
  f.guest.sendInputEvent.mockImplementation((event: { type?: string }) => {
    if (event.type !== 'mouseUp') return;
    for (const [item, state] of [[f.item, 'completed'], [interrupted, 'interrupted']] as const) {
      const claim = claimBrowserAgentDownload(
        electron.partition as unknown as Electron.Session,
        item,
        f.guest as unknown as Electron.WebContents,
      );
      expect(claim?.savePath).toBeTruthy();
      paths.push(claim!.savePath!);
      fs.writeFileSync(claim!.savePath!, state === 'completed' ? 'saved' : 'partial');
      claim?.settle(item, state);
    }
  });

  const result = await bridge!.executeCommand('justdo:session-1', {
    action: 'act',
    request: { kind: 'batch', actions: [{ kind: 'click', selector: '#export' }] },
  }) as {
    content: Array<{ type: string; text: string }>;
    details: { downloads: Array<Record<string, unknown>> };
  };

  expect(result).toMatchObject({
    isError: true,
    details: { ok: false, results: [{ ok: true }], downloads: [
      { state: 'completed', path: paths[0], mimeType: 'image/jpeg', receivedBytes: 12, totalBytes: 12 },
      { state: 'interrupted', mimeType: 'text/csv', receivedBytes: 3, totalBytes: 0 },
    ] },
  });
  expect(result.details.downloads[1]).not.toHaveProperty('path');
  expect(fs.existsSync(paths[0]!)).toBe(true);
  expect(fs.existsSync(paths[1]!)).toBe(false);
  expect(result.content[0]?.text).toContain('"results"');
  expect(result.content[1]?.text).toContain('"downloads"');
  expect(result.content[1]?.text).toContain('"state": "interrupted"');
  expect(result.content[1]?.text).toContain('Do not repeat the action');
  expect(result.content[1]?.text).not.toContain(JSON.stringify(paths[1]));
  expect(f.guest.sendInputEvent.mock.calls.filter(([event]) => event.type === 'mouseUp')).toHaveLength(1);
});

test('preserves completed automatic downloads alongside a sanitized save-path error', async () => {
  const f = createUrlDownloadFixture();
  const failedItem = { ...f.item, getFilename: () => 'denied.csv', cancel: vi.fn() };
  const outputResolver = bridge! as unknown as {
    resolveManagedOutputPath(sessionId: string, requestedPath: string | undefined, name: string): string;
  };
  const originalResolve = outputResolver.resolveManagedOutputPath.bind(bridge);
  const resolver = vi.spyOn(outputResolver, 'resolveManagedOutputPath').mockImplementation(
    (sessionId, requestedPath, name) => {
      if (name.endsWith('-denied.csv')) {
        throw new Error('Output unavailable: https://user:secret@example.test/export?access_token=secret');
      }
      return originalResolve(sessionId, requestedPath, name);
    },
  );
  let completedPath = '';
  f.guest.sendInputEvent.mockImplementation((event: { type?: string }) => {
    if (event.type !== 'mouseUp') return;
    const completed = f.claim();
    completedPath = completed!.savePath!;
    fs.writeFileSync(completedPath, 'saved');
    completed?.settle(f.item, 'completed');
    const failed = claimBrowserAgentDownload(
      electron.partition as unknown as Electron.Session,
      failedItem,
      f.guest as unknown as Electron.WebContents,
    );
    expect(failed).toMatchObject({ cancelled: true, savePath: null });
  });

  try {
    const result = await bridge!.executeCommand('justdo:session-1', {
      action: 'act', request: { kind: 'click', selector: '#exports' },
    }) as {
      content: Array<{ type: string; text: string }>;
      details: { downloads: Array<Record<string, unknown>>; downloadErrors: Array<Record<string, unknown>> };
    };

    expect(result).toMatchObject({
      isError: true,
      details: { ok: false, downloads: [{ state: 'completed', path: completedPath }], downloadErrors: [{
        error: 'Output unavailable: https://example.test/export?access_token=%5BREDACTED%5D',
      }] },
    });
    expect(result.details.downloads).toHaveLength(1);
    expect(result.details.downloadErrors[0]).not.toHaveProperty('state');
    expect(result.details.downloadErrors[0]).not.toHaveProperty('path');
    expect(fs.readFileSync(completedPath, 'utf8')).toBe('saved');
    expect(failedItem.cancel).toHaveBeenCalledOnce();
    expect(result.content[1]?.text).toContain('"downloadErrors"');
    expect(result.content[1]?.text).toContain('"state": "completed"');
    expect(result.content[1]?.text).toContain('Do not repeat the action');
    expect(JSON.stringify(result)).not.toContain('secret');
  } finally {
    resolver.mockRestore();
  }
});

test('rejects cancellation while waiting for automatic download settlement', async () => {
  vi.useFakeTimers();
  const f = createUrlDownloadFixture();
  f.guest.sendInputEvent.mockImplementation((event: { type?: string }) => {
    if (event.type === 'mouseUp') expect(f.claim()?.savePath).toBeTruthy();
  });
  const controller = new AbortController();
  const pending = bridge!.executeCommand('justdo:session-1', {
    action: 'act', request: { kind: 'click', selector: '#export' },
  }, controller.signal);
  const rejection = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.guest.sendInputEvent).toHaveBeenCalled();
  controller.abort();

  await rejection;
  expect(f.item.cancel).toHaveBeenCalledOnce();
  expect(f.claim()).toBeNull();
});

test('tracks the action network lifecycle until a delayed download response starts', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-slow-download-'));
  temporaryRoots.push(temporaryRoot);
  const download = {
    cancel: vi.fn(),
    getFilename: () => 'slow.pdf',
    getURL: () => 'https://example.com/slow.pdf',
    getMimeType: () => 'application/pdf',
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
      getMimeType: () => 'application/pdf',
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
