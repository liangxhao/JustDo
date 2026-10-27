import { EventEmitter } from 'events';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => void>(),
  guests: new Map<number, unknown>(),
  policyGuests: new WeakSet<object>(),
  partition: { storagePath: 'C:\\profiles\\embedded' },
  host: {
    create: vi.fn(),
    owns: vi.fn(),
    has: vi.fn(),
    getFailure: vi.fn(),
    close: vi.fn(),
    closeScope: vi.fn(),
    stop: vi.fn(),
    waitForDrain: vi.fn(async () => {}),
  },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (key: string, callback: never) => state.handlers.set(key, callback),
    on: (key: string, callback: never) => state.handlers.set(key, callback),
    removeHandler: vi.fn(),
  },
  session: { fromPartition: () => state.partition },
  webContents: { fromId: (id: number) => state.guests.get(id) },
}));
vi.mock('./backgroundBrowserHost', () => ({
  BackgroundBrowserHost: class {
    constructor() {
      return state.host;
    }
  },
}));
vi.mock('./browserSessionPolicy', () => ({
  isBrowserSessionPolicyGuest: (guest: object) => state.policyGuests.has(guest),
}));
vi.mock('./data/browserDataImportService', () => ({
  listImportedBrowserProfiles: () => [],
  listChromeImportSources: () => [],
}));
vi.mock('../core/network/systemProxyPreference', () => ({
  registerBrowserProxySession: async () => undefined,
}));

import { BrowserIpc } from '../../shared/browser/browser';
import { BrowserAgentBridge } from './browserAgentBridge';

let bridge: BrowserAgentBridge;
let nextId = 20;
let send: ReturnType<typeof vi.fn>;
const scope = (runId = 'run-1', headlessOnly = false) => ({
  sessionId: 'conversation',
  runId,
  workspaceDir: path.resolve('workspace'),
  headlessOnly,
});
const event = () => ({
  sender: { id: 1, getType: () => 'window', mainFrame: { processId: 2, routingId: 3 } },
  senderFrame: { processId: 2, routingId: 3 },
});
const guest = (background: boolean) => {
  const events = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  let attached = false;
  let destroyed = false;
  let url = 'about:blank';
  const contents = Object.assign(events, {
    id: nextId++,
    session: state.partition,
    hostWebContents: { id: 1 },
    isDestroyed: () => destroyed,
    getType: () => (background ? 'window' : 'webview'),
    getURL: () => url,
    getTitle: () => 'Synthetic page',
    focus: vi.fn(),
    stop: vi.fn(),
    destroy: () => {
      destroyed = true;
      events.emit('destroyed');
    },
    loadURL: vi.fn(async (value: string) => {
      url = value;
    }),
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      sendCommand: vi.fn(async () => ({})),
    }),
  });
  state.guests.set(contents.id, contents);
  return contents;
};
const getGuest = (id: number) => state.guests.get(id) as ReturnType<typeof guest>;
type PageResult = { targetId: string; headless: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  state.handlers.clear();
  state.guests.clear();
  state.policyGuests = new WeakSet();
  nextId = 20;
  state.host.create.mockImplementation(async () => guest(true));
  state.host.owns.mockImplementation(
    (tab, contents) =>
      tab.webContentsId === contents.id &&
      contents.getType() === 'window' &&
      !contents.isDestroyed(),
  );
  state.host.has.mockImplementation((id: number) => getGuest(id)?.getType() === 'window');
  state.host.getFailure.mockReturnValue(null);
  state.host.close.mockImplementation((id: number) => getGuest(id)?.destroy());
  send = vi.fn((channel, payload) => {
    if (channel !== BrowserIpc.AgentEnsureTab) return;
    const contents = guest(false);
    state.handlers.get(BrowserIpc.AgentRegisterTab)?.(event(), {
      ...payload,
      webContentsId: contents.id,
    });
  });
  bridge = new BrowserAgentBridge(send, id => id === 1);
  bridge.registerIpc();
});
afterEach(async () => {
  await bridge.stop();
});
const execute = (command: Record<string, unknown>, runId = 'run-1', headlessOnly = false) =>
  bridge.executeCommand(
    'agent:main:justdo:conversation',
    command,
    undefined,
    scope(runId, headlessOnly),
  );

test('ordinary omission and false use the existing sidebar creation path', async () => {
  await execute({ action: 'open', url: 'https://example.com' });
  await execute({ action: 'open', url: 'https://example.com/second', headless: false });
  expect(send.mock.calls.filter(([channel]) => channel === BrowserIpc.AgentEnsureTab)).toHaveLength(
    2,
  );
  expect(state.host.create).not.toHaveBeenCalled();
});

test('rejects embed registration even with the sidebar host and profile storage while allowing a sidebar page', async () => {
  const embed = guest(false);
  const sidebar = guest(false);
  state.policyGuests.add(embed);
  for (const [contents, targetId] of [[embed, 'embed-page'], [sidebar, 'sidebar-page']] as const) {
    state.handlers.get(BrowserIpc.AgentRegisterTab)?.(event(), {
      sessionId: 'conversation',
      targetId,
      profile: 'embedded',
      webContentsId: contents.id,
    });
  }

  await expect(execute({ action: 'tabs' })).resolves.toMatchObject({
    tabCount: 1,
    tabs: [expect.objectContaining({ targetId: 'sidebar-page' })],
  });
  await expect(execute({ action: 'focus', targetId: 'embed-page' })).rejects.toThrow(
    'Browser tab not found',
  );
  await expect(execute({ action: 'focus', targetId: 'sidebar-page' })).resolves.toMatchObject({
    targetId: 'sidebar-page',
  });
  expect(embed.debugger.isAttached()).toBe(false);
});

test('refuses an existing browser reference once its page is identified as an embed', async () => {
  const contents = guest(false);
  state.handlers.get(BrowserIpc.AgentRegisterTab)?.(event(), {
    sessionId: 'conversation',
    targetId: 'existing-page',
    profile: 'embedded',
    webContentsId: contents.id,
  });
  await expect(execute({ action: 'focus', targetId: 'existing-page' })).resolves.toMatchObject({
    targetId: 'existing-page',
  });

  state.policyGuests.add(contents);

  await expect(execute({ action: 'focus', targetId: 'existing-page' })).rejects.toThrow(
    'Browser tab not found',
  );
  await expect(execute({ action: 'tabs' })).resolves.toMatchObject({ tabCount: 0, tabs: [] });
  expect(contents.loadURL).not.toHaveBeenCalled();
  expect(state.host.create).not.toHaveBeenCalled();
});

test('explicit true creates a Main-owned page without Renderer interaction or focus', async () => {
  const result = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  expect(result).toMatchObject({ ok: true, headless: true });
  expect(state.host.create).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'conversation', profile: 'embedded' }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(getGuest(20).focus).not.toHaveBeenCalled();
});

test('an existing target keeps its background mode when a subsequent call omits headless', async () => {
  const page = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  await expect(execute({ action: 'focus', targetId: page.targetId })).resolves.toMatchObject({
    headless: true,
  });
  await expect(
    execute({ action: 'focus', targetId: page.targetId, headless: false }),
  ).rejects.toThrow('display mode');
  expect(send).not.toHaveBeenCalled();
});

test('a new native turn defaults new pages to sidebar, while explicit old background targets remain usable', async () => {
  const page = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  await execute({ action: 'open', url: 'https://example.com/new' }, 'run-2');
  expect(state.host.create).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(BrowserIpc.AgentEnsureTab, expect.anything());
  send.mockClear();
  await expect(
    execute({ action: 'focus', targetId: page.targetId }, 'run-2'),
  ).resolves.toMatchObject({ headless: true });
  expect(send).not.toHaveBeenCalled();
});

test('cron omission is forced into the background and false is rejected', async () => {
  await expect(
    execute({ action: 'open', url: 'https://example.com' }, 'cron-run', true),
  ).resolves.toMatchObject({ headless: true });
  await expect(
    execute({ action: 'open', url: 'https://example.com', headless: false }, 'cron-run', true),
  ).rejects.toThrow('requires headless=true');
  expect(send).not.toHaveBeenCalled();
});

test('foreground and background pages share the per-conversation tab limit', async () => {
  bridge = new BrowserAgentBridge(
    send,
    id => id === 1,
    () => null,
    false,
    undefined,
    () => 1,
  );
  bridge.registerIpc();
  await execute({ action: 'open', url: 'https://example.com' });
  await expect(
    execute({ action: 'open', url: 'https://example.com', headless: true }),
  ).rejects.toThrow('at most 1');
  expect(state.host.create).not.toHaveBeenCalled();
});

test('closing a background page destroys its owned host and sends no Renderer close', async () => {
  const page = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  await execute({ action: 'close', targetId: page.targetId });
  expect(state.host.close).toHaveBeenCalledWith(20);
  expect(send).not.toHaveBeenCalled();
  await expect(execute({ action: 'focus', targetId: page.targetId })).rejects.toThrow('not found');
});

test('background lifecycle cleanup clears owned scopes without closing sidebar pages', async () => {
  await execute({ action: 'open', url: 'https://example.com' });
  const page = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  bridge.releaseExecutionScope('conversation', true);
  expect(state.host.closeScope).toHaveBeenCalledWith('conversation');
  await expect(execute({ action: 'focus', targetId: page.targetId })).rejects.toThrow('not found');
  const pages = (await execute({ action: 'tabs' })) as { tabCount: number };
  expect(pages.tabCount).toBe(1);
});

test('workspace-only browser calls reject local file URLs before any page is created', async () => {
  await expect(
    bridge.executeCommand(
      'agent:main:justdo:conversation',
      {
        action: 'open',
        url: 'file:///outside/private.html',
        headless: true,
      },
      undefined,
      { ...scope(), allowLocalFiles: false },
    ),
  ).rejects.toThrow('Only http and https');
  expect(state.host.create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('waits for background session cleanup before completing bridge shutdown', async () => {
  let releaseDrain!: () => void;
  state.host.waitForDrain.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        releaseDrain = resolve;
      }),
  );
  let stopped = false;
  const pending = bridge.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(state.host.stop).toHaveBeenCalledOnce();
  expect(state.host.waitForDrain).toHaveBeenCalledOnce();
  expect(stopped).toBe(false);

  releaseDrain();
  await pending;

  expect(stopped).toBe(true);
});

test('reports uncertain background cleanup during bridge shutdown', async () => {
  state.host.waitForDrain.mockRejectedValueOnce(new Error('cleanup blocked'));

  await expect(bridge.stop()).rejects.toThrow('cleanup blocked');
});

test('workspace-only policy refuses an existing file document before browser evaluation', async () => {
  const page = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  const contents = getGuest(20);
  await contents.loadURL('file:///outside/private.html');
  contents.debugger.sendCommand.mockClear();
  await expect(
    bridge.executeCommand(
      'agent:main:justdo:conversation',
      {
        action: 'snapshot',
        targetId: page.targetId,
      },
      undefined,
      { ...scope(), allowLocalFiles: false },
    ),
  ).rejects.toThrow('Local file pages');
  expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
});

test('workspace-only execution blocks a page-triggered local navigation and removes temporary guards', async () => {
  const page = (await execute({
    action: 'open',
    url: 'https://example.com',
    headless: true,
  })) as PageResult;
  const contents = getGuest(20);
  const preventDefault = vi.fn();
  contents.getTitle = () => {
    contents.emit('will-frame-navigate', { url: 'file:///outside/private.html', preventDefault });
    return 'Synthetic page';
  };
  await expect(
    bridge.executeCommand(
      'agent:main:justdo:conversation',
      {
        action: 'focus',
        targetId: page.targetId,
      },
      undefined,
      { ...scope(), allowLocalFiles: false },
    ),
  ).rejects.toThrow('Local file navigation was blocked');
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(contents.listenerCount('will-frame-navigate')).toBe(0);
});
