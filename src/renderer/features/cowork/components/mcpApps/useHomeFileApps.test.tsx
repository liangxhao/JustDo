// @vitest-environment jsdom
import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useHomeFileApps } from './useHomeFileApps';
import type { McpAppWorkspaceFileEntry } from './workspaceApps';

interface TestHost {
  isCurrent: () => boolean;
  canInteract?: () => boolean;
}
interface TestConnection {
  connected: boolean;
  listeners: Set<() => void>;
}
const f = vi.hoisted(() => ({
  prepare: vi.fn<(host: TestHost) => Promise<TestHost>>(),
  discover: vi.fn<() => Promise<McpAppDiscovery>>(),
  launch: vi.fn(),
  invalidate: vi.fn(),
  dispose: vi.fn(),
  adopt: vi.fn(),
  hosts: [] as TestHost[],
  connections: [] as TestConnection[],
  initiallyConnected: true,
  configListeners: new Set<() => void>(),
  open: vi.fn(),
}));
vi.mock('@/libs/openclaw-chat/gateway/mcp-workspace-session', () => ({
  McpWorkspaceSession: class {
    connected = f.initiallyConnected;
    listeners = new Set<() => void>();
    constructor(
      _scope: unknown,
      readonly host: TestHost,
    ) {
      f.hosts.push(host);
      f.connections.push(this);
    }
    apps = { discover: f.discover, launch: f.launch, invalidate: f.invalidate };
    subscribeConnection = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    prepare = () => f.prepare(this.host);
    discover = async (signal?: AbortSignal) => {
      const binding = await f.prepare(this.host);
      signal?.throwIfAborted();
      const value = await f.discover();
      signal?.throwIfAborted();
      return { value, isCurrent: binding.isCurrent };
    };
    dispose = f.dispose;
    adopt = f.adopt;
  },
}));
vi.mock('@/libs/openclaw-chat/pipeline/native-mcp-app', () => ({
  decodeMcpAppLaunch: (value: unknown) => value,
}));
vi.mock('./workspaceApps', () => ({
  openWorkspaceAppFile: f.open,
  openWorkspaceAppLaunch: f.open,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  f.hosts.length = 0;
  f.connections.length = 0;
  f.initiallyConnected = true;
  f.configListeners.clear();
});

function setup(running = false) {
  vi.stubGlobal('electron', {
    mcp: {
      onConfigSyncDone: (listener: () => void) => {
        f.configListeners.add(listener);
        return () => f.configListeners.delete(listener);
      },
    },
    openclaw: {
      engine: {
        onProgress: () => () => {},
        getStatus: async () => ({
          success: true,
          status: { phase: running ? 'running' : 'ready' },
        }),
      },
    },
  });
  f.discover.mockResolvedValue({
    servers: [
      {
        serverName: 'sheet',
        label: 'Sheet',
        entrypoints: [
          {
            toolName: 'preview_file',
            title: 'Preview',
            resourceUri: 'ui://sheet/editor',
            entrypoint: { type: 'file', extensions: ['.xlsx'] },
          },
        ],
      },
    ],
  });
  f.prepare.mockImplementation(async host => ({
    isCurrent: host.isCurrent,
    resume: () => ({ isCurrent: host.isCurrent }),
  }));
  f.launch.mockResolvedValue({ viewId: 'view' });
  const options = {
    currentSessionId: null as string | null,
    sessionInteractive: true,
    enabled: true,
    cwd: 'E:/workspace',
    agentId: 'main',
    permissionMode: 'auto',
    addDraft: vi.fn(),
  };
  const hook = renderHook((props = options) => useHomeFileApps(props), { initialProps: options });
  const request = { filePath: 'E:/workspace/预算.xlsx', isCurrent: () => true };
  return { ...hook, options, request };
}

test('keeps a stopped runtime lazy and opens files explicitly without mounting a chat', async () => {
  const { result, request } = setup();
  expect(f.prepare).not.toHaveBeenCalled();
  await act(async () => expect(await result.current.openFile(request)).toBe(true));
  const entry = f.open.mock.calls[0][0] as McpAppWorkspaceFileEntry;
  expect(entry).toMatchObject({
    sessionId: '__home__',
    filePath: request.filePath,
    label: '预算.xlsx',
  });
  expect(f.launch).not.toHaveBeenCalled();
  const loaded = await entry.load(new AbortController().signal);
  expect(loaded.preview.viewId).toBe('view');
  expect(f.launch).toHaveBeenCalledOnce();
});

test('ordinary preview remains available when no file handler matches or Gateway is unavailable', async () => {
  const { result, request } = setup();
  expect(await result.current.openFile({ ...request, filePath: 'E:/workspace/notes.md' })).toBe(
    false,
  );
  f.prepare.mockRejectedValueOnce(new Error('Gateway unavailable'));
  expect(await result.current.openFile(request)).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
});

test('leaving home during discovery cannot create a tab or launch a tool', async () => {
  const { result, request, rerender, options } = setup();
  let finish!: (value: McpAppDiscovery) => void;
  f.discover.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = result.current.openFile(request);
  await act(async () => {});
  rerender({ ...options, enabled: false });
  finish({ servers: [] });
  expect(await pending).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispose).not.toHaveBeenCalled();
  expect(f.invalidate).toHaveBeenCalledWith(true);
});

test('changing the homepage workspace revokes a reserved file load', async () => {
  const { result, request, rerender, options } = setup();
  expect(await result.current.openFile(request)).toBe(true);
  const entry = f.open.mock.calls[0][0] as McpAppWorkspaceFileEntry;
  rerender({ ...options, cwd: 'E:/other' });
  await expect(entry.load(new AbortController().signal)).rejects.toThrow('changed');
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.hosts[0].isCurrent()).toBe(false);
});

test('reload discovers again and rejects a removed handler instead of replaying it', async () => {
  const { result, request } = setup();
  await result.current.openFile(request);
  const loaded = await (f.open.mock.calls[0][0] as McpAppWorkspaceFileEntry).load(
    new AbortController().signal,
  );
  f.discover.mockResolvedValueOnce({ servers: [] });
  await expect(loaded.context.reopen?.()).rejects.toThrow('no longer available');
  expect(f.launch).toHaveBeenCalledOnce();
});

test('opening the home menu discovers real global Apps and launches only the chosen entry', async () => {
  const { result, rerender, options } = setup();
  f.discover.mockResolvedValue({
    servers: [
      {
        serverName: 'drawio',
        label: 'draw.io',
        entrypoints: [
          {
            toolName: 'open_editor',
            title: 'Editor',
            resourceUri: 'ui://drawio/editor',
            entrypoint: { type: 'global' },
          },
          {
            toolName: 'file',
            title: 'File',
            resourceUri: 'ui://drawio/file',
            entrypoint: { type: 'file', extensions: ['.drawio'] },
          },
        ],
      },
    ],
  });
  expect(result.current.menu.items.map(item => item.id)).toEqual(['mcp-app-discovery']);
  expect(f.prepare).not.toHaveBeenCalled();
  await act(async () => result.current.discover());
  expect(result.current.menu.items.map(item => item.label)).toEqual(['draw.io']);
  expect(f.launch).not.toHaveBeenCalled();
  const item = result.current.menu.items[0];
  act(() => item.onSelect());
  const entry = f.open.mock.lastCall![0];
  expect(entry).toMatchObject({ sessionId: '__home__', retryable: false, label: 'draw.io' });
  expect(f.launch).not.toHaveBeenCalled();
  await entry.load(new AbortController().signal);
  expect(f.launch).toHaveBeenCalledExactlyOnceWith(
    {
      serverName: 'drawio',
      toolName: 'open_editor',
      entrypointType: 'global',
    },
    expect.any(AbortSignal),
  );
  rerender({ ...options, enabled: false });
  item.onSelect();
  expect(result.current.menu.items).toEqual([]);
  expect(f.open).toHaveBeenCalledOnce();
});

test('home navigation preserves its owner and explicit file reopen uses the new navigation scope', async () => {
  const { result, request, rerender, options } = setup();
  await result.current.openFile(request);
  const entry = f.open.mock.lastCall![0] as McpAppWorkspaceFileEntry;
  const loaded = await entry.load(new AbortController().signal);
  rerender({ ...options, enabled: false });
  rerender(options);
  expect(f.dispose).not.toHaveBeenCalled();
  expect(f.hosts).toHaveLength(1);
  await expect(entry.load(new AbortController().signal)).rejects.toThrow('changed');
  const resumed = loaded.context.resume!();
  expect(resumed?.reopen).toBeTypeOf('function');
  await expect(resumed!.reopen!()).resolves.toHaveProperty('preview.viewId', 'view');
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test('a valid global catalog finishing across navigation stays cached without launching', async () => {
  const { result, rerender, options } = setup();
  let finish!: (value: McpAppDiscovery) => void;
  f.discover.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = result.current.discover();
  await act(async () => {});
  rerender({ ...options, enabled: false });
  rerender(options);
  await act(async () => {
    finish({
      servers: [
        {
          serverName: 'old',
          label: 'Old',
          entrypoints: [
            {
              toolName: 'open',
              title: 'Old',
              resourceUri: 'ui://old',
              entrypoint: { type: 'global' },
            },
          ],
        },
      ],
    });
    await pending;
  });
  expect(result.current.menu.items.map(item => item.id)).toEqual(['mcp-app:old:open']);
  expect(f.discover).toHaveBeenCalledOnce();
  expect(f.launch).not.toHaveBeenCalled();
});

test('cached home callbacks cannot launch or open files while another conversation is active', async () => {
  const { result, rerender, options, request } = setup();
  f.discover.mockResolvedValueOnce({
    servers: [
      {
        serverName: 'drawio',
        label: 'draw.io',
        entrypoints: [
          {
            toolName: 'open_editor',
            title: 'Editor',
            resourceUri: 'ui://drawio/editor',
            entrypoint: { type: 'global' },
          },
        ],
      },
    ],
  });
  await act(async () => result.current.discover());
  const item = result.current.menu.items[0];

  rerender({ ...options, enabled: false });
  item.onSelect();

  await expect(result.current.openFile(request)).resolves.toBe(false);
  expect(result.current.menu.items).toEqual([]);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.prepare).toHaveBeenCalledOnce();
});

test('configuration refresh revokes old menu callbacks even after the same catalog returns', async () => {
  const { result } = setup(true);
  const catalog: McpAppDiscovery = {
    servers: [
      {
        serverName: 'drawio',
        label: 'draw.io',
        entrypoints: [
          {
            toolName: 'open_editor',
            title: 'Editor',
            resourceUri: 'ui://drawio/editor',
            entrypoint: { type: 'global' },
          },
        ],
      },
    ],
  };
  f.discover.mockResolvedValue(catalog);
  await act(async () => {});
  const oldItem = result.current.menu.items[0];
  let finish!: (value: McpAppDiscovery) => void;
  f.discover.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  await act(async () => {
    for (const listener of f.configListeners) listener();
    oldItem.onSelect();
  });
  expect(f.open).not.toHaveBeenCalled();
  await act(async () => finish(catalog));
  act(() => oldItem.onSelect());
  expect(f.open).not.toHaveBeenCalled();
  act(() => result.current.menu.items[0].onSelect());
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.launch).not.toHaveBeenCalled();
});

test('reconnect refreshes the retained home catalog while an existing conversation remains selected', async () => {
  const { result, rerender, options } = setup(true);
  await act(async () => {});
  rerender({ ...options, enabled: false });
  const connection = f.connections[0];
  expect(connection.listeners.size).toBe(1);
  act(() => {
    connection.connected = false;
    for (const listener of connection.listeners) listener();
  });
  f.discover.mockResolvedValueOnce({
    servers: [
      {
        serverName: 'drawio',
        label: 'draw.io',
        entrypoints: [
          {
            toolName: 'open_editor',
            title: 'Editor',
            resourceUri: 'ui://drawio/editor',
            entrypoint: { type: 'global' },
          },
        ],
      },
    ],
  });

  await act(async () => {
    connection.connected = true;
    for (const listener of connection.listeners) listener();
  });

  expect(f.discover).toHaveBeenCalledTimes(2);
  expect(result.current.menu.items).toEqual([]);
  rerender(options);
  await act(async () => result.current.discover());
  expect(result.current.menu.items[0].label).toBe('draw.io');
  expect(f.discover).toHaveBeenCalledTimes(2);
  expect(f.launch).not.toHaveBeenCalled();
});

test('an authenticated reconnect refreshes the home catalog without launching an App', async () => {
  const { result } = setup(true);
  await act(async () => {});
  expect(f.discover).toHaveBeenCalledOnce();
  const connection = f.connections[0];
  act(() => {
    connection.connected = false;
    for (const listener of connection.listeners) listener();
  });
  expect(result.current.menu.items[0]).toMatchObject({
    id: 'mcp-app-discovery',
    disabled: false,
  });
  await act(async () => {
    connection.connected = true;
    for (const listener of connection.listeners) listener();
  });
  expect(f.discover).toHaveBeenCalledTimes(2);
  expect(f.launch).not.toHaveBeenCalled();
});

test('a close before the first hello cannot leave the prefetch failed or permanently loading', async () => {
  f.initiallyConnected = false;
  const { result } = setup(true);
  let finish!: (host: TestHost) => void;
  f.prepare.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await act(async () => {});
  expect(f.prepare).toHaveBeenCalledOnce();
  const connection = f.connections[0];
  act(() => {
    for (const listener of connection.listeners) listener();
  });
  expect(result.current.menu.items[0].disabled).toBe(false);
  await act(async () => {
    connection.connected = true;
    for (const listener of connection.listeners) listener();
    finish(f.hosts[0]);
  });
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.discover).toHaveBeenCalledOnce();
  expect(result.current.menu.items).toEqual([]);
  expect(f.launch).not.toHaveBeenCalled();
});

test('first-send promotion keeps the same canvas and adopts its owner without a launch replay', async () => {
  const h = setup();
  await act(async () => {
    await h.result.current.openFile(h.request);
  });
  const host = f.hosts[0];
  let requestId: string | undefined;
  act(() => {
    requestId = h.result.current.beginStart('temp-first');
  });
  expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'temp-first' });
  expect(host.isCurrent()).toBe(true);
  expect(host.canInteract?.()).toBe(true);
  expect(f.invalidate).not.toHaveBeenCalled();
  act(() => h.result.current.promote('temp-first', 'conversation'));
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'conversation' });
  expect(f.adopt).toHaveBeenCalledExactlyOnceWith('conversation');
  expect(host.isCurrent()).toBe(true);
  expect(host.canInteract?.()).toBe(true);
  expect(f.invalidate).not.toHaveBeenCalled();
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'other' });
  expect(host.canInteract?.()).toBe(false);
  expect(f.invalidate).toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
});

test.each(['temp-failed', 'other-chat'])(
  'a failed first send restores its owner after navigation to %s',
  async selected => {
    const h = setup(true);
    await act(async () => {
      await h.result.current.discover();
    });
    const originalHost = f.hosts[0];
    act(() => {
      h.result.current.beginStart('temp-failed');
    });
    h.rerender({ ...h.options, enabled: false, currentSessionId: 'temp-failed' });
    await act(async () => {});
    expect(f.hosts.length).toBeGreaterThan(1);
    h.rerender({ ...h.options, enabled: false, currentSessionId: selected });
    act(() => h.result.current.rollback('temp-failed'));
    h.rerender(h.options);
    expect(originalHost.isCurrent()).toBe(true);
    expect(originalHost.canInteract?.()).toBe(true);
    expect(f.adopt).not.toHaveBeenCalled();
  },
);

test('a pending first send prevents another home App source from replacing the rollback canvas', async () => {
  const h = setup(true);
  await act(async () => h.result.current.openFile(h.request));
  const original = f.hosts[0];
  act(() => h.result.current.beginStart('temp-pending'));
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'temp-pending' });
  h.rerender(h.options);
  await act(async () => {});

  expect(await h.result.current.openFile(h.request)).toBe(false);
  expect(f.open).toHaveBeenCalledOnce();
  act(() => h.result.current.rollback('temp-pending'));
  expect(original.isCurrent()).toBe(true);
  expect(original.canInteract?.()).toBe(true);
  expect(await h.result.current.openFile(h.request)).toBe(true);
});

test('rollback refreshes the App catalog when the user has already returned home', async () => {
  const h = setup(true);
  await act(async () => h.result.current.discover());
  act(() => h.result.current.beginStart('temp-pending'));
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'temp-pending' });
  h.rerender(h.options);
  await act(async () => {});
  expect(h.result.current.menu.fileCatalog?.servers).toHaveLength(1);

  await act(async () => h.result.current.rollback('temp-pending'));

  expect(h.result.current.menu.fileCatalog?.servers).toHaveLength(1);
});

test('a failed first send releases its preview when the homepage configuration changed', async () => {
  const h = setup();
  await act(async () => h.result.current.openFile(h.request));
  const original = f.hosts[0];
  act(() => h.result.current.beginStart('temp-old-config'));
  h.rerender({ ...h.options, cwd: 'E:/another-workspace' });

  act(() => h.result.current.rollback('temp-old-config'));

  expect(original.isCurrent()).toBe(false);
  expect(f.dispose).toHaveBeenCalledOnce();
});

test('opening the same file on a new homepage keeps the adopted canvas in a different tab', async () => {
  const h = setup();
  await act(async () => h.result.current.openFile(h.request));
  const originalEntry = f.open.mock.lastCall![0] as McpAppWorkspaceFileEntry;
  const originalHost = f.hosts[0];
  act(() => {
    h.result.current.beginStart('temp-first');
    h.result.current.promote('temp-first', 'canonical-chat');
  });
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'canonical-chat' });
  h.rerender(h.options);

  await act(async () => h.result.current.openFile(h.request));
  const nextEntry = f.open.mock.lastCall![0] as McpAppWorkspaceFileEntry;

  expect(nextEntry.id).not.toBe(originalEntry.id);
  expect(originalHost.isCurrent()).toBe(true);
  expect(f.dispose).not.toHaveBeenCalled();
});

test('an adopted canvas pauses during a transcript mutation in its own conversation', async () => {
  const h = setup();
  await act(async () => {
    await h.result.current.openFile(h.request);
  });
  const originalHost = f.hosts[0];
  act(() => {
    h.result.current.beginStart('temp-first');
    h.result.current.promote('temp-first', 'conversation');
  });
  h.rerender({ ...h.options, enabled: false, currentSessionId: 'conversation' });
  expect(originalHost.canInteract?.()).toBe(true);
  h.rerender({
    ...h.options,
    enabled: false,
    currentSessionId: 'conversation',
    sessionInteractive: false,
  });
  expect(originalHost.canInteract?.()).toBe(false);
  expect(f.invalidate).toHaveBeenCalled();
});
