// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';

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
