// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';

import type { McpServerConfig } from './mcp';

test('an old extension inventory read cannot restore state after a native switch', async () => {
  vi.resetModules();
  let finishInitial!: (result: unknown) => void;
  const disabled = { id: 'extension:plugin:server', name: 'server', enabled: false };
  const listExtensionServers = vi
    .fn()
    .mockReturnValueOnce(
      new Promise(resolve => {
        finishInitial = resolve;
      }),
    )
    .mockResolvedValue({ success: true, extensionServers: [disabled] });
  const setExtensionEnabled = vi.fn(async () => ({ success: true, extensionServers: [disabled] }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: { onChanged: () => () => undefined },
      mcp: { listExtensionServers, setExtensionEnabled },
    },
  });
  const { mcpService } = await import('./mcpService');
  const initial = mcpService.loadExtensionServers();
  await mcpService.setExtensionServerEnabled(disabled.id, false);
  finishInitial({ success: true, extensionServers: [{ ...disabled, enabled: true }] });
  expect(await initial).toEqual([disabled]);
  expect(mcpService.getExtensionServers()).toEqual([disabled]);
  expect(setExtensionEnabled).toHaveBeenCalledTimes(1);
});

test.each(['create', 'update', 'delete', 'setEnabled'])(
  'a list started before MCP %s cannot overwrite its confirmed inventory',
  async operation => {
    vi.resetModules();
    let finishOld!: (result: { success: boolean; servers: McpServerConfig[] }) => void;
    const current = { id: 'current', name: 'Current server' } as McpServerConfig;
    const list = vi.fn(
      () =>
        new Promise(resolve => {
          finishOld = resolve;
        }),
    );
    const mutate = vi.fn(async () => ({ success: true, servers: [current] }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { mcp: { list, [operation]: mutate } },
    });
    const { mcpService } = await import('./mcpService');
    const oldLoad = mcpService.loadServers();

    if (operation === 'create')
      await mcpService.createServer({
        name: 'Current server',
        transportType: 'stdio',
        command: 'node',
      });
    if (operation === 'update')
      await mcpService.updateServer('current', { name: 'Current server' });
    if (operation === 'delete') await mcpService.deleteServer('removed');
    if (operation === 'setEnabled') await mcpService.setServerEnabled('current', true);
    finishOld({ success: true, servers: [] });

    expect(await oldLoad).toEqual([current]);
    expect(mcpService.getServers()).toEqual([current]);
  },
);

test('a delayed MCP mutation reply cannot overwrite a newer confirmed deletion', async () => {
  vi.resetModules();
  let finishUpdate!: (result: { success: boolean; servers: McpServerConfig[] }) => void;
  const removed = { id: 'removed' } as McpServerConfig;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcp: {
        list: vi.fn(async () => ({ success: true, servers: [] })),
        update: vi.fn(
          () =>
            new Promise(resolve => {
              finishUpdate = resolve;
            }),
        ),
        delete: vi.fn(async () => ({ success: true, servers: [] })),
      },
    },
  });
  const { mcpService } = await import('./mcpService');
  const updating = mcpService.updateServer('removed', { name: 'Updated server' });

  await mcpService.deleteServer('removed');
  finishUpdate({ success: true, servers: [removed] });

  expect(await updating).toMatchObject({ success: true, servers: [] });
  expect(mcpService.getServers()).toEqual([]);
});

test('a superseded failed MCP list preserves the confirmed inventory', async () => {
  vi.resetModules();
  let rejectOld!: (error: Error) => void;
  const current = { id: 'current' } as McpServerConfig;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcp: {
        list: vi.fn(
          () =>
            new Promise((_resolve, reject) => {
              rejectOld = reject;
            }),
        ),
        create: vi.fn(async () => ({ success: true, servers: [current] })),
      },
    },
  });
  const { mcpService } = await import('./mcpService');
  const oldLoad = mcpService.loadServers();

  await mcpService.createServer({ name: 'Current', transportType: 'stdio', command: 'node' });
  rejectOld(new Error('IPC failed'));

  expect(await oldLoad).toEqual([current]);
  expect(mcpService.getServers()).toEqual([current]);
});

test('deduplicates inventory requests, keeps a snapshot, and refreshes after extension changes', async () => {
  vi.resetModules();
  let changed!: () => void;
  const listExtensionServers = vi.fn(async () => ({
    success: true,
    extensionServers: [{ id: 'initial' }],
  }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: {
        onChanged: (callback: () => void) => {
          changed = callback;
          return () => undefined;
        },
      },
      mcp: { listExtensionServers },
    },
  });
  const { mcpService } = await import('./mcpService');
  await Promise.all([mcpService.loadExtensionServers(), mcpService.loadExtensionServers()]);
  expect(listExtensionServers).toHaveBeenCalledOnce();
  expect(mcpService.getExtensionServers()).toEqual([{ id: 'initial' }]);
  changed();
  expect(mcpService.getExtensionServers()).toBeNull();
  listExtensionServers.mockResolvedValue({ success: true, extensionServers: [{ id: 'updated' }] });
  await mcpService.loadExtensionServers();
  expect(mcpService.getExtensionServers()).toEqual([{ id: 'updated' }]);
});

test('does not publish an inventory response overtaken by an extension change', async () => {
  vi.resetModules();
  let changed!: () => void;
  let finish!: (result: { success: boolean; extensionServers: { id: string }[] }) => void;
  const listExtensionServers = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ success: true, extensionServers: [{ id: 'current' }] });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: {
        onChanged: (callback: () => void) => {
          changed = callback;
          return () => undefined;
        },
      },
      mcp: { listExtensionServers },
    },
  });
  const { mcpService } = await import('./mcpService');
  const pending = mcpService.loadExtensionServers();
  changed();
  finish({ success: true, extensionServers: [{ id: 'stale' }] });
  expect(await pending).toEqual([{ id: 'current' }]);
  expect(mcpService.getExtensionServers()).toEqual([{ id: 'current' }]);
});

test('a list consumed after a same-turn mutation cannot restore the prior MCP switch state', async () => {
  vi.resetModules();
  let finishRead!: (result: { success: boolean; servers: McpServerConfig[] }) => void;
  let finishSwitch!: (result: { success: boolean; servers: McpServerConfig[] }) => void;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcp: {
        list: vi.fn(() => new Promise(resolve => (finishRead = resolve))),
        setEnabled: vi.fn(() => new Promise(resolve => (finishSwitch = resolve))),
      },
    },
  });
  const server = { id: 'example', enabled: true } as McpServerConfig;
  const { mcpService } = await import('./mcpService');
  const consumed: boolean[] = [];
  const reading = mcpService.loadServers().then(servers => consumed.push(servers[0].enabled));
  const switching = mcpService
    .setServerEnabled(server.id, false)
    .then(servers => consumed.push(servers[0].enabled));
  finishRead({ success: true, servers: [server] });
  finishSwitch({ success: true, servers: [{ ...server, enabled: false }] });
  await Promise.all([reading, switching]);

  expect(consumed[consumed.length - 1]).toBe(false);
  expect(mcpService.getServers()[0].enabled).toBe(false);
});

test('preserves the confirmed MCP inventory and read failure after a supplementary query fails', async () => {
  vi.resetModules();
  let finishUpdate!: (result: { success: boolean; servers: McpServerConfig[] }) => void;
  const newer = { id: 'newer', name: 'Newer native server' } as McpServerConfig;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcp: {
        list: vi.fn(async () => ({ success: false, error: 'Native inventory unavailable' })),
        update: vi.fn(() => new Promise(resolve => (finishUpdate = resolve))),
        create: vi.fn(async () => ({ success: true, servers: [newer] })),
      },
    },
  });
  const { mcpService } = await import('./mcpService');
  const updating = mcpService.updateServer('example', { name: 'Updated' });
  await mcpService.createServer({ name: newer.name, transportType: 'stdio', command: 'node' });
  finishUpdate({ success: true, servers: [] });

  expect(await updating).toMatchObject({ success: true, servers: [newer] });
  expect(mcpService.getServers()).toEqual([newer]);
  expect(mcpService.hasServerLoadFailed()).toBe(true);
});

test('an extension change after normalization still supersedes the pending provider-list consumer', async () => {
  vi.resetModules();
  let changed!: () => void;
  let finish!: (result: { success: boolean; extensionServers: { id: string }[] }) => void;
  const listExtensionServers = vi
    .fn()
    .mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
    .mockResolvedValue({ success: true, extensionServers: [{ id: 'newer-provider' }] });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: { onChanged: (listener: () => void) => ((changed = listener), () => undefined) },
      mcp: { listExtensionServers },
    },
  });
  const { mcpService } = await import('./mcpService');
  const oldRead = mcpService.loadExtensionServers();
  finish({ success: true, extensionServers: [{ id: 'old-provider' }] });
  await Promise.resolve();
  await Promise.resolve();
  changed();
  await mcpService.loadExtensionServers();

  expect(await oldRead).toEqual([{ id: 'newer-provider' }]);
  expect(mcpService.getExtensionServers()).toEqual([{ id: 'newer-provider' }]);
  expect(listExtensionServers).toHaveBeenCalledTimes(2);
});
