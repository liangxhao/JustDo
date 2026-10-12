// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { getExtensionProvidedManagement } from '@shared/plugins/management';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ExtensionProvidedMcpServer, McpServerConfig } from './mcp';
import McpManager from './McpManager';
import { mcpService } from './mcpService';
import mcpReducer from './mcpSlice';

vi.mock('@/features/plugins/marketplace/MarketplaceView', () => ({
  MarketplaceResults: () => null,
  default: () => null,
}));
vi.mock('./mcpService', () => ({
  mcpService: {
    loadServers: vi.fn(async () => []),
    loadExtensionServers: vi.fn(async () => []),
    getExtensionServers: vi.fn(() => null),
    getServers: vi.fn(() => []),
    hasServerLoadFailed: vi.fn(() => false),
    setServerEnabled: vi.fn(),
    createServer: vi.fn(),
    updateServer: vi.fn(),
    probeServer: vi.fn(),
    deleteServer: vi.fn(),
    onConfigSyncStart: vi.fn(() => () => undefined),
    onConfigSyncDone: vi.fn(() => () => undefined),
  },
}));

vi.mock('@/features/plugins/marketplace/usePluginMarketplace', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/plugins/marketplace/usePluginMarketplace')>();
  return {
    ...actual,
    usePluginMarketplace: (options: { onInstalled?: () => Promise<void> }) => ({
      filter: 'all',
      source: null,
      query: '',
      updateById: new Map(),
      recentlyUpdated: new Set(),
      operations: {},
      matchesInstalled: (_id: string, matches: boolean) => matches,
      operationFor: () => undefined,
      setFilter: () => undefined,
      refreshInventory: options.onInstalled,
    }),
  };
});

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));

const demoServer = (scope: 'personal' | 'system', enabled = true): ExtensionProvidedMcpServer => ({
  id: `extension:${scope}:demo`,
  name: `${scope}-mcp`,
  providerId: `${scope}-plugin`,
  providerName: `${scope}-plugin`,
  providerDescription: 'Demo MCP',
  enabled,
  supported: true,
  ...getExtensionProvidedManagement({ id: `${scope}-plugin`, scope }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mcpService.loadServers).mockReset().mockResolvedValue([]);
  vi.mocked(mcpService.setServerEnabled).mockReset();
  vi.mocked(mcpService.getServers).mockReset().mockReturnValue([]);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: { onChanged: vi.fn(() => () => undefined) },
    },
  });
  vi.mocked(mcpService.probeServer).mockResolvedValue({
    success: true,
    result: {
      available: true,
      latencyMs: 5,
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      resources: [],
      prompts: [],
    },
  });
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([
    demoServer('personal'),
    demoServer('system'),
  ]);
});
afterEach(cleanup);

const renderManager = (searchQuery = '') => {
  const onOpenExtension = vi.fn();
  render(
    <Provider store={configureStore({ reducer: { mcp: mcpReducer } })}>
      <McpManager
        searchQuery={searchQuery}
        visibility="installed"
        onOpenExtension={onOpenExtension}
      />
    </Provider>,
  );
  return onOpenExtension;
};

const customServer: McpServerConfig = {
  id: 'user-mcp',
  name: 'User MCP',
  description: 'Custom MCP',
  enabled: true,
  transportType: 'stdio',
  command: 'node',
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 1,
};

test('a late initial read cannot restore the old MCP switch state or leave loading active', async () => {
  let finishRead!: (servers: McpServerConfig[]) => void;
  let finishSwitch!: (servers: McpServerConfig[]) => void;
  vi.mocked(mcpService.loadServers).mockReturnValueOnce(
    new Promise(resolve => (finishRead = resolve)),
  );
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
  vi.mocked(mcpService.setServerEnabled).mockReturnValueOnce(
    new Promise(resolve => (finishSwitch = resolve)),
  );
  const store = configureStore({
    reducer: { mcp: mcpReducer },
    preloadedState: { mcp: { servers: [customServer] } },
  });
  render(
    <Provider store={store}>
      <McpManager visibility="installed" />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('switch', { name: 'disableMcpServer' }));
  await act(async () => {
    vi.mocked(mcpService.getServers).mockReturnValue([{ ...customServer, enabled: false }]);
    finishRead([customServer]);
    finishSwitch([{ ...customServer, enabled: false }]);
  });

  expect(store.getState().mcp.servers[0].enabled).toBe(false);
  expect(screen.queryByText('mcpLoadingServers')).toBeNull();
});

test('an extension refresh started during an MCP switch is consumed after the switch ends', async () => {
  let finishRead!: (servers: McpServerConfig[]) => void;
  let finishSwitch!: (servers: McpServerConfig[]) => void;
  const disabled = { ...customServer, enabled: false };
  const added = { ...customServer, id: 'added-server', name: 'Added MCP' };
  vi.mocked(mcpService.loadServers)
    .mockResolvedValueOnce([customServer])
    .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)));
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
  vi.mocked(mcpService.setServerEnabled).mockReturnValueOnce(
    new Promise(resolve => (finishSwitch = resolve)),
  );
  renderManager();
  fireEvent.click(await screen.findByRole('switch', { name: 'disableMcpServer' }));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  await act(async () => {
    vi.mocked(mcpService.getServers).mockReturnValue([disabled]);
    finishSwitch([disabled]);
  });
  await act(async () => finishRead([disabled, added]));

  expect(screen.getByText('Added MCP')).toBeTruthy();
  expect(screen.queryByText('mcpLoadingServers')).toBeNull();
});

test.each([true, false])(
  'shows MCP deletion progress until it finishes (success: %s)',
  async success => {
    let finish!: (result: {
      success: boolean;
      servers?: McpServerConfig[];
      error?: string;
    }) => void;
    vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
    vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
    vi.mocked(mcpService.deleteServer).mockReturnValueOnce(
      new Promise(resolve => (finish = resolve)),
    );
    renderManager();
    await screen.findByText(customServer.name);
    fireEvent.click(screen.getByRole('button', { name: 'editMcpServer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deleteMcpServer' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmDelete' }));
    const deleting = screen.getByRole('button', { name: 'confirmDelete' });
    expect(deleting.getAttribute('aria-busy')).toBe('true');
    expect(deleting.hasAttribute('disabled')).toBe(true);
    expect(deleting.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(deleting);
    expect(mcpService.deleteServer).toHaveBeenCalledOnce();

    await act(async () =>
      finish({ success, servers: success ? [] : undefined, error: 'Delete refused' }),
    );

    if (success) expect(screen.queryByRole('button', { name: 'confirmDelete' })).toBeNull();
    else {
      expect(screen.getAllByText('Delete refused').length).toBeGreaterThan(0);
      const retry = screen.getByRole('button', { name: 'confirmDelete' });
      expect(retry.getAttribute('aria-busy')).toBeNull();
      expect(retry.hasAttribute('disabled')).toBe(false);
      expect(retry.querySelector('.animate-spin')).toBeNull();
    }
  },
);

test('a late MCP mutation consumes the current projection without erasing newer server metadata', async () => {
  let finish!: (servers: McpServerConfig[]) => void;
  const disabled = { ...customServer, enabled: false };
  const added = { ...customServer, id: 'new-provider-server', name: 'Newer MCP' };
  vi.mocked(mcpService.loadServers)
    .mockResolvedValueOnce([customServer])
    .mockResolvedValueOnce([disabled, added]);
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
  vi.mocked(mcpService.setServerEnabled).mockReturnValueOnce(
    new Promise(resolve => (finish = resolve)),
  );
  renderManager();
  fireEvent.click(await screen.findByRole('switch', { name: 'disableMcpServer' }));
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  expect(screen.getByText(added.name)).toBeTruthy();
  vi.mocked(mcpService.getServers).mockReturnValue([disabled, added]);
  await act(async () => finish([disabled]));

  expect(screen.getByText(added.name)).toBeTruthy();
  expect(screen.getByRole('switch', { name: 'enableMcpServer' }).getAttribute('aria-checked')).toBe(
    'false',
  );
});

test('keeps the confirmed servers visible while reporting a native inventory-read failure', async () => {
  vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
  vi.mocked(mcpService.hasServerLoadFailed).mockReturnValueOnce(true);
  renderManager();

  await screen.findByText(customServer.name);
  expect(screen.getByText('mcpLoadFailed')).toBeTruthy();
  expect(screen.queryByText('mcpNoInstalledServers')).toBeNull();
});

test('a failed creation reconciles the inventory when it superseded the initial page read', async () => {
  let finishRead!: (servers: McpServerConfig[]) => void;
  vi.mocked(mcpService.loadServers)
    .mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)))
    .mockResolvedValueOnce([customServer]);
  vi.mocked(mcpService.getServers).mockReturnValue([customServer]);
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
  vi.mocked(mcpService.createServer).mockResolvedValue({
    success: false,
    error: 'Native create refused',
  });
  renderManager();
  fireEvent.click(screen.getByRole('button', { name: /addMcpServer/ }));
  const name = await screen.findByPlaceholderText('mcpServerNamePlaceholder');
  fireEvent.change(name, { target: { value: 'Another MCP' } });
  fireEvent.change(screen.getByPlaceholderText('mcpCommandPlaceholder'), {
    target: { value: 'node' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
  await screen.findByText('Native create refused');
  expect(screen.getByText(customServer.name)).toBeTruthy();
  expect(screen.queryByText('mcpLoadingServers')).toBeNull();
  await act(async () => finishRead([]));

  expect(screen.getByText(customServer.name)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'saveMcpServer' }).hasAttribute('disabled')).toBe(
    false,
  );
});

test('saving a user MCP does not discard an in-flight extension-provided inventory', async () => {
  let finishUserRead!: (servers: McpServerConfig[]) => void;
  let finishProviderRead!: (servers: ExtensionProvidedMcpServer[]) => void;
  const provider = { ...demoServer('personal'), name: 'Refreshed provider MCP' };
  vi.mocked(mcpService.loadServers)
    .mockResolvedValueOnce([customServer])
    .mockReturnValueOnce(new Promise(resolve => (finishUserRead = resolve)));
  vi.mocked(mcpService.loadExtensionServers)
    .mockResolvedValueOnce([demoServer('personal')])
    .mockReturnValueOnce(new Promise(resolve => (finishProviderRead = resolve)));
  vi.mocked(mcpService.getServers).mockReturnValue([customServer]);
  vi.mocked(mcpService.updateServer).mockResolvedValueOnce({
    success: true,
    servers: [customServer],
  });
  renderManager();
  await screen.findByText('personal-mcp');
  fireEvent.click(screen.getByRole('button', { name: 'editMcpServer' }));
  await screen.findByRole('button', { name: 'saveMcpServer' });
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' })));
  expect(screen.getByText('mcpLoadingServers')).toBeTruthy();
  await act(async () => finishProviderRead([provider]));

  expect(screen.getByText(provider.name)).toBeTruthy();
  expect(screen.queryByText('mcpLoadingServers')).toBeNull();
  await act(async () => finishUserRead([]));
  expect(screen.getByText(customServer.name)).toBeTruthy();
  expect(screen.getByText(provider.name)).toBeTruthy();
  expect(mcpService.updateServer).toHaveBeenCalledOnce();
});

test('removes the last user MCP after confirmed deletion without displaying an unavailable error', async () => {
  const server: McpServerConfig = {
    id: 'user-mcp',
    name: 'User MCP',
    description: 'Custom MCP service',
    enabled: true,
    transportType: 'stdio',
    command: 'node',
    isBuiltIn: false,
    createdAt: 1,
    updatedAt: 1,
  };
  vi.mocked(mcpService.loadServers).mockResolvedValue([server]);
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([]);
  vi.mocked(mcpService.deleteServer).mockResolvedValue({ success: true, servers: [] });
  renderManager();
  await screen.findByText('User MCP');

  fireEvent.click(screen.getByRole('button', { name: 'editMcpServer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'deleteMcpServer' }));
  fireEvent.click(screen.getByRole('button', { name: 'confirmDelete' }));

  await screen.findByText('mcpNoInstalledServers');
  expect(screen.queryByText('User MCP')).toBeNull();
  expect(screen.queryByText('mcpDeleteFailed')).toBeNull();
  expect(screen.queryByText(/unavailable/i)).toBeNull();
  expect(mcpService.deleteServer).toHaveBeenCalledWith('user-mcp');
});

test('shows imported extension MCP immediately under user installs while keeping bundled MCP collapsed', async () => {
  const onOpenExtension = renderManager();
  await screen.findByText('personal-mcp');
  const userSection = screen.getByText('pluginGroup.user.label').closest('section')!;
  const systemSection = screen.getByText('pluginGroup.system.label').closest('section')!;
  expect(within(userSection).queryByText('mcpNoInstalledServers')).toBeNull();
  expect(within(userSection).getByText('personal-mcp').closest('[hidden]')).toBeNull();
  expect(within(userSection).queryByText('system-mcp')).toBeNull();
  expect(within(userSection).queryByRole('switch')).toBeNull();
  fireEvent.click(within(userSection).getByRole('button', { name: 'openExtensionDetails' }));
  expect(onOpenExtension).toHaveBeenCalledWith('personal-plugin');
  const expand = within(systemSection).getByRole('button', { expanded: false });
  expect(within(systemSection).getByText('system-mcp').closest('[hidden]')).toBeTruthy();
  fireEvent.click(expand);
  expect(within(systemSection).getByText('system-mcp').closest('[hidden]')).toBeNull();
});

test('keeps disabled imported MCP visible and searches by its parent extension', async () => {
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([demoServer('personal', false)]);
  renderManager('personal-plugin');
  await screen.findByText('personal-mcp');
  expect(screen.getByText('mcpExtensionDisabled')).toBeTruthy();
  expect(screen.queryByText('pluginGroup.system.label')).toBeNull();
  expect(screen.queryByText('mcpNoInstalledServers')).toBeNull();
});

test.each(['', 'personal'])(
  'shows animated loading with search "%s" while discovery is pending',
  async search => {
    let finish!: (servers: ExtensionProvidedMcpServer[]) => void;
    vi.mocked(mcpService.loadExtensionServers).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    renderManager(search);
    expect(screen.getByText('mcpLoadingServers')).toBeTruthy();
    expect(screen.getByRole('status').querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByText('mcpNoInstalledServers')).toBeNull();
    finish([demoServer('personal')]);
    await screen.findByText('personal-mcp');
    expect(screen.queryByText('mcpLoadingServers')).toBeNull();
  },
);

test('retesting replaces cached results with animated connection progress', async () => {
  renderManager();
  fireEvent.click(await screen.findByRole('button', { name: 'personal-mcp' }));
  await screen.findByText('echo');
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  let finish!: (value: Awaited<ReturnType<typeof mcpService.probeServer>>) => void;
  vi.mocked(mcpService.probeServer).mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'personal-mcp' }));
  expect(screen.getByText('mcpTestingServer')).toBeTruthy();
  expect(screen.getByRole('status').querySelector('.animate-spin')).toBeTruthy();
  expect(screen.queryByText('echo')).toBeNull();
  await act(async () => {
    finish({
      success: true,
      result: { available: true, tools: [], resources: [], prompts: [], latencyMs: 1 },
    });
  });
});

test('an older load failure cannot end a refresh or display an empty inventory', async () => {
  let rejectOld!: (error: Error) => void;
  let finishNew!: (servers: ExtensionProvidedMcpServer[]) => void;
  vi.mocked(mcpService.loadExtensionServers)
    .mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
    )
    .mockReturnValueOnce(
      new Promise(resolve => {
        finishNew = resolve;
      }),
    );
  renderManager();
  const changed = vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0];
  act(() => changed({ extensionId: 'personal-plugin', enabled: true }));
  await act(async () => {
    rejectOld(new Error('outdated request failed'));
  });
  expect(screen.getByText('mcpLoadingServers')).toBeTruthy();
  expect(screen.queryByText('mcpNoInstalledServers')).toBeNull();
  expect(screen.queryByText('mcpLoadFailed')).toBeNull();
  await act(async () => {
    finishNew([demoServer('personal')]);
  });
  expect(screen.getByText('personal-mcp')).toBeTruthy();
});

test('opens imported MCP details from the name and tests the native extension id', async () => {
  renderManager();
  fireEvent.click(await screen.findByRole('button', { name: 'personal-mcp' }));
  await screen.findByText('echo');
  fireEvent.click(screen.getByRole('button', { name: /echo/ }));
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:personal:demo');
  expect(screen.getByText('mcpDetailInputSchema')).toBeTruthy();
});

test('includes enabled imported MCP in all tests and exposes a per-server test button', async () => {
  renderManager();
  await screen.findByText('personal-mcp');
  const section = screen.getByText('pluginGroup.user.label').closest('section')!;
  expect(within(section).getByRole('button', { name: 'mcpTestShort' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'mcpTestAll' }));
  await screen.findAllByText('mcpProbeStatusAvailable');
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:personal:demo');
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:system:demo');
});

test('allows details for disabled MCP without opening its transport', async () => {
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([demoServer('personal', false)]);
  renderManager();
  fireEvent.click(await screen.findByRole('button', { name: 'personal-mcp' }));
  await screen.findByText('mcpDetailErrorReason');
  expect(mcpService.probeServer).not.toHaveBeenCalled();
});

test('does not mark a disabled extension available when an earlier probe finishes', async () => {
  let finish!: (value: Awaited<ReturnType<typeof mcpService.probeServer>>) => void;
  vi.mocked(mcpService.probeServer).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  renderManager();
  fireEvent.click(await screen.findByRole('button', { name: 'personal-mcp' }));
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([demoServer('personal', false)]);
  const changed = vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0];
  await act(async () => {
    changed({ extensionId: 'personal-plugin', enabled: false });
  });
  expect(screen.getByText('mcpExtensionDisabled')).toBeTruthy();
  await act(async () => {
    finish({
      success: true,
      result: { available: true, tools: [], resources: [], prompts: [], latencyMs: 1 },
    });
  });
  expect(screen.queryByText('mcpProbeStatusAvailable')).toBeNull();
});

test('does not claim an empty inventory when extension discovery failed', async () => {
  vi.mocked(mcpService.loadExtensionServers).mockRejectedValue(new Error('discovery unavailable'));
  renderManager();
  await screen.findByText('mcpLoadFailed');
  expect(screen.queryByText('mcpNoInstalledServers')).toBeNull();
});

test('a successful user switch preserves a provider error until provider discovery recovers', async () => {
  const disabled = { ...customServer, enabled: false };
  vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
  vi.mocked(mcpService.loadExtensionServers).mockRejectedValueOnce(
    new Error('provider unavailable'),
  );
  vi.mocked(mcpService.hasServerLoadFailed).mockReturnValue(false);
  vi.mocked(mcpService.getServers).mockReturnValue([disabled]);
  vi.mocked(mcpService.setServerEnabled).mockResolvedValue([disabled]);
  renderManager();
  await screen.findByText('mcpLoadFailed');

  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'disableMcpServer' })));

  expect(screen.getByRole('switch', { name: 'enableMcpServer' }).getAttribute('aria-checked')).toBe(
    'false',
  );
  expect(screen.getByText('mcpLoadFailed')).toBeTruthy();
  expect(mcpService.loadExtensionServers).toHaveBeenCalledTimes(1);

  let finishProviderRead!: (servers: ExtensionProvidedMcpServer[]) => void;
  vi.mocked(mcpService.loadServers).mockResolvedValue([]);
  vi.mocked(mcpService.loadExtensionServers).mockReturnValueOnce(
    new Promise(resolve => (finishProviderRead = resolve)),
  );
  await act(async () => {
    vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0]({
      extensionId: 'provider',
      enabled: true,
    });
  });
  expect(screen.getByText('mcpLoadFailed')).toBeTruthy();
  expect(screen.queryByText('mcpNoInstalledServers')).toBeNull();

  await act(async () => finishProviderRead([]));

  expect(screen.queryByText('mcpLoadFailed')).toBeNull();
  expect(screen.getByText('mcpNoInstalledServers')).toBeTruthy();
});
