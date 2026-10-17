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
    setExtensionServerEnabled: vi.fn(),
    readExtensionSettings: vi.fn(),
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
  vi.mocked(mcpService.setExtensionServerEnabled).mockReset();
  vi.mocked(mcpService.readExtensionSettings).mockReset();
  vi.mocked(mcpService.getExtensionServers).mockReset().mockReturnValue(null);
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

const findCardProbe = async (name = 'personal-mcp') => {
  const card = (await screen.findByText(name)).closest('article')!;
  return within(card).getByRole('button', { name: 'mcpTestServer' });
};

test('configuration sync succeeds silently and reports failures in a dismissible dialog', async () => {
  renderManager();
  await screen.findByText('personal-mcp');
  const syncStart = vi.mocked(mcpService.onConfigSyncStart).mock.calls.at(-1)![0];
  const syncDone = vi.mocked(mcpService.onConfigSyncDone).mock.calls.at(-1)![0];

  act(() => syncStart());
  act(() => syncDone({ tools: 0 }));
  expect(screen.queryByText(/mcpBridgeSyncDone/)).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();

  act(() => syncStart());
  act(() => syncDone({ tools: 0, error: 'Connection refused' }));
  const dialog = screen.getByRole('alertdialog', { name: 'mcpBridgeSyncError' });
  expect(within(dialog).getByText('Connection refused')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'close' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

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

const editableExtensionServer = (): ExtensionProvidedMcpServer => {
  const server = demoServer('personal');
  return {
    ...server,
    transportType: 'stdio',
    connectionSummary: 'node server.mjs [REDACTED]',
    connectionTimeoutMs: 30000,
    requestTimeoutMs: 60000,
    management: {
      ...server.management!,
      enable: { allowed: true },
      disable: { allowed: true },
      configure: { allowed: true },
    },
  };
};

test('switches an extension MCP independently and consumes the confirmed native inventory', async () => {
  const server = editableExtensionServer();
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([server]);
  vi.mocked(mcpService.setExtensionServerEnabled).mockResolvedValue([
    { ...server, enabled: false },
  ]);
  renderManager();
  await screen.findByText(server.name);
  fireEvent.click(screen.getByRole('switch', { name: 'disableMcpServer' }));
  await screen.findByRole('switch', { name: 'enableMcpServer' });
  expect(mcpService.setExtensionServerEnabled).toHaveBeenCalledWith(server.id, false);
  expect(mcpService.setServerEnabled).not.toHaveBeenCalled();
  expect(mcpService.readExtensionSettings).not.toHaveBeenCalled();
  expect(screen.queryByText('stdio')).toBeNull();
});

test('an extension switch supersedes a late initial provider read and finishes loading', async () => {
  const server = editableExtensionServer();
  let finishInitial!: (servers: ExtensionProvidedMcpServer[]) => void;
  vi.mocked(mcpService.getExtensionServers).mockReturnValue([server]);
  vi.mocked(mcpService.loadExtensionServers).mockReturnValue(
    new Promise(resolve => {
      finishInitial = resolve;
    }),
  );
  vi.mocked(mcpService.setExtensionServerEnabled).mockResolvedValue([
    { ...server, enabled: false },
  ]);
  renderManager();
  fireEvent.click(screen.getByRole('switch', { name: 'disableMcpServer' }));
  await screen.findByRole('switch', { name: 'enableMcpServer' });
  expect(screen.queryByText('mcpLoadingServers')).toBeNull();
  await act(async () => finishInitial([server]));
  expect(screen.getByRole('switch', { name: 'enableMcpServer' })).toBeTruthy();
});

test('views parameters of a locked extension MCP without launching a probe', async () => {
  const server = { ...demoServer('personal'), connectionSummary: 'node server.mjs [REDACTED]' };
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([server]);
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({
    success: true,
    value: { server, revision: 'native-revision', definition: null, override: null },
  });
  renderManager();
  await screen.findByText(server.name);
  fireEvent.click(screen.getByText('mcpProvidedByExtension'));
  expect(
    ((await screen.findByDisplayValue(server.connectionSummary)) as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  expect((screen.getByLabelText('mcpServerName') as HTMLInputElement).value).toBe(server.name);
  expect(screen.queryByText('mcpDetailStatus')).toBeNull();
  expect(screen.queryByLabelText('mcpNativeOverride')).toBeNull();
  expect(screen.queryByRole('button', { name: 'saveMcpServer' })).toBeNull();
  expect(mcpService.probeServer).not.toHaveBeenCalled();
});

test('opens the user MCP editor by clicking the card description without testing the connection', async () => {
  vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
  renderManager();
  fireEvent.click(await screen.findByText(customServer.description));
  expect(await screen.findByDisplayValue(customServer.name)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'saveMcpServer' })).toBeTruthy();
  expect(screen.queryByTitle('editMcpServer')).toBeNull();
  expect(mcpService.probeServer).not.toHaveBeenCalled();
  expect(mcpService.setServerEnabled).not.toHaveBeenCalled();
});

test('tests saved user MCP settings from the editor and preserves unsaved input when Escape closes the result', async () => {
  vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
  renderManager();
  fireEvent.click(await screen.findByText(customServer.description));
  const command = await screen.findByPlaceholderText('mcpCommandPlaceholder');
  fireEvent.change(command, { target: { value: 'unsaved-command' } });
  fireEvent.click(screen.getByRole('button', { name: 'mcpTestSavedConfiguration' }));
  await screen.findByText('echo');

  expect(mcpService.probeServer).toHaveBeenCalledExactlyOnceWith(customServer.id);
  expect(mcpService.updateServer).not.toHaveBeenCalled();
  expect(mcpService.setServerEnabled).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByText('echo')).toBeNull();
  expect((screen.getByPlaceholderText('mcpCommandPlaceholder') as HTMLInputElement).value).toBe(
    'unsaved-command',
  );
  expect(screen.getByRole('button', { name: 'saveMcpServer' })).toBeTruthy();
});

test.each([false, true])(
  'saving a changed user MCP invalidates earlier probe feedback (pending: %s)',
  async pending => {
    vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
    const changedServer = { ...customServer, command: 'changed-command', updatedAt: 2 };
    vi.mocked(mcpService.getServers).mockReturnValue([changedServer]);
    vi.mocked(mcpService.updateServer).mockResolvedValue({
      success: true,
      servers: [changedServer],
    });
    let finish!: (value: Awaited<ReturnType<typeof mcpService.probeServer>>) => void;
    if (pending) {
      vi.mocked(mcpService.probeServer).mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve;
        }),
      );
    }
    renderManager();
    fireEvent.click(await findCardProbe(customServer.name));
    if (!pending) await screen.findByText('echo');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: `editMcpServer: ${customServer.name}` }));
    const command = await screen.findByPlaceholderText('mcpCommandPlaceholder');
    fireEvent.change(command, { target: { value: 'changed-command' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' })));
    if (pending) {
      await act(async () =>
        finish({
          success: true,
          result: {
            available: true,
            latencyMs: 1,
            tools: [{ name: 'old-connection-tool' }],
            resources: [],
            prompts: [],
          },
        }),
      );
    }
    expect((await findCardProbe(customServer.name)).getAttribute('title')).not.toContain(
      'mcpProbeStatusAvailable',
    );
    expect(screen.queryByText('mcpTestingServer')).toBeNull();
  },
);

test('a probe started during a user MCP switch cannot survive its committed state change', async () => {
  vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
  const disabled = { ...customServer, enabled: false };
  vi.mocked(mcpService.getServers).mockReturnValue([disabled]);
  let finishSwitch!: (servers: McpServerConfig[]) => void;
  vi.mocked(mcpService.setServerEnabled).mockReturnValueOnce(
    new Promise(resolve => {
      finishSwitch = resolve;
    }),
  );
  let finishProbe!: (value: Awaited<ReturnType<typeof mcpService.probeServer>>) => void;
  vi.mocked(mcpService.probeServer).mockReturnValueOnce(
    new Promise(resolve => {
      finishProbe = resolve;
    }),
  );
  renderManager();
  const toggle = await screen.findByRole('switch', { name: 'disableMcpServer' });
  fireEvent.click(toggle);
  fireEvent.click(await findCardProbe(customServer.name));
  await act(async () => finishSwitch([disabled]));
  await act(async () =>
    finishProbe({
      success: true,
      result: { available: true, latencyMs: 1, tools: [], resources: [], prompts: [] },
    }),
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect((await findCardProbe(customServer.name)).getAttribute('title')).not.toContain(
    'mcpProbeStatusAvailable',
  );
});

test('tests an extension MCP from the read-only parameter window without changing its definition', async () => {
  const server = editableExtensionServer();
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([server]);
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({
    success: true,
    value: {
      server,
      revision: 'native-revision',
      definition: { command: 'node', args: ['original.mjs'] },
      override: null,
    },
  });
  renderManager();
  fireEvent.click(await screen.findByText(server.name));
  const editor = await screen.findByLabelText('mcpRawParametersJson');
  const original = (editor as HTMLTextAreaElement).value;
  fireEvent.click(screen.getByText('mcpRawParameters'));
  fireEvent.click(screen.getByRole('button', { name: 'mcpTestSavedConfiguration' }));
  await screen.findByText('echo');
  expect(mcpService.probeServer).toHaveBeenCalledExactlyOnceWith(server.id);
  expect(mcpService.setExtensionServerEnabled).not.toHaveBeenCalled();

  const overlays = document.querySelectorAll<HTMLElement>('[data-workspace-overlay]');
  fireEvent.click(within(overlays[overlays.length - 1]).getByRole('button', { name: 'close' }));
  expect((screen.getByLabelText('mcpRawParametersJson') as HTMLTextAreaElement).value).toBe(
    original,
  );
  expect(screen.queryByRole('button', { name: 'saveMcpServer' })).toBeNull();
});

test('allows testing a disabled extension MCP from the read-only parameter window', async () => {
  const server = demoServer('personal', false);
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([server]);
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({
    success: true,
    value: { server, revision: 'native-revision', definition: null, override: null },
  });
  renderManager();
  fireEvent.click(await screen.findByText(server.name));
  await screen.findByLabelText('mcpServerName');
  fireEvent.click(screen.getByRole('button', { name: 'mcpTestSavedConfiguration' }));
  await screen.findByText('echo');
  expect(mcpService.probeServer).toHaveBeenCalledExactlyOnceWith(server.id);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect((screen.getByLabelText('mcpServerName') as HTMLInputElement).readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'saveMcpServer' })).toBeNull();
});

test('clears stale probe progress after an extension toggle', async () => {
  const server = editableExtensionServer();
  let finish!: (value: Awaited<ReturnType<typeof mcpService.probeServer>>) => void;
  vi.mocked(mcpService.probeServer).mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  vi.mocked(mcpService.loadServers).mockResolvedValue([customServer]);
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([server]);
  vi.mocked(mcpService.setExtensionServerEnabled).mockResolvedValue([
    { ...server, enabled: false },
  ]);
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({
    success: true,
    value: { server, revision: 'native-revision', definition: null, override: null },
  });
  renderManager();
  const userCard = (await screen.findByText(customServer.name)).closest('.group')!;
  const testButton = within(userCard as HTMLElement).getByRole('button', {
    name: 'mcpTestServer',
  });
  fireEvent.click(testButton);
  expect((testButton as HTMLButtonElement).disabled).toBe(true);
  // A different server remains editable while this connection test is pending.
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  await act(async () =>
    fireEvent.click(
      within(screen.getByText(server.name).closest('.group')! as HTMLElement).getByRole('switch'),
    ),
  );
  expect((testButton as HTMLButtonElement).disabled).toBe(false);
  await act(async () =>
    finish({
      success: true,
      result: { available: true, tools: [], resources: [], prompts: [], latencyMs: 1 },
    }),
  );
  expect(screen.queryByText('mcpProbeStatusAvailable')).toBeNull();
  expect(testButton.getAttribute('title')).not.toContain('mcpProbeStatusAvailable');
  expect((testButton as HTMLButtonElement).disabled).toBe(false);
});

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
    fireEvent.click(screen.getByRole('button', { name: `editMcpServer: ${customServer.name}` }));
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
  fireEvent.click(screen.getByRole('button', { name: `editMcpServer: ${customServer.name}` }));
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

  fireEvent.click(screen.getByRole('button', { name: `editMcpServer: ${customServer.name}` }));
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
  expect(mcpService.readExtensionSettings).not.toHaveBeenCalled();
  const expand = within(systemSection).getByRole('button', { expanded: false });
  expect(within(systemSection).getByText('system-mcp').closest('[hidden]')).toBeTruthy();
  fireEvent.click(expand);
  expect(within(systemSection).getByText('system-mcp').closest('[hidden]')).toBeNull();
});

test('keeps disabled imported MCP visible and searches by its parent extension', async () => {
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([demoServer('personal', false)]);
  renderManager('personal-plugin');
  await screen.findByText('personal-mcp');
  expect(screen.queryByText('pluginStatusDisabled')).toBeNull();
  expect(
    screen.getByRole('img', { name: 'pluginStatusDisabled · mcpExtensionToggleUnavailable' }),
  ).toBeTruthy();
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
  fireEvent.click(await findCardProbe());
  await screen.findByText('echo');
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  let finish!: (value: Awaited<ReturnType<typeof mcpService.probeServer>>) => void;
  vi.mocked(mcpService.probeServer).mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  fireEvent.click(await findCardProbe());
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

test('opens test details from the MCP test icon without opening parameters', async () => {
  renderManager();
  fireEvent.click(await findCardProbe());
  await screen.findByText('echo');
  expect(screen.getByRole('button', { name: 'mcpTestServer' }).getAttribute('title')).toContain(
    'mcpProbeStatusAvailable',
  );
  fireEvent.click(screen.getByRole('button', { name: /echo/ }));
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:personal:demo');
  expect(mcpService.readExtensionSettings).not.toHaveBeenCalled();
  expect(screen.getByText('mcpDetailInputSchema')).toBeTruthy();
});

test('includes disabled supported extension MCP in all tests without enabling them', async () => {
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([
    demoServer('personal', false),
    demoServer('system', false),
  ]);
  renderManager();
  await screen.findByText('personal-mcp');
  const section = screen.getByText('pluginGroup.user.label').closest('section')!;
  const testButton = within(section).getByRole('button', { name: 'mcpTestServer' });
  expect(testButton.textContent).toBe('');
  expect((testButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'mcpTestAll' }));
  await screen.findAllByText('mcpProbeStatusAvailable');
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:personal:demo');
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:system:demo');
  expect(mcpService.setExtensionServerEnabled).not.toHaveBeenCalled();
  expect(mcpService.setServerEnabled).not.toHaveBeenCalled();
});

test('tests a disabled extension MCP independently of its saved enabled state', async () => {
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([demoServer('personal', false)]);
  renderManager();
  const testButton = await findCardProbe();
  expect((testButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(testButton);
  await screen.findByText('echo');
  expect(testButton.getAttribute('title')).toContain('mcpProbeStatusAvailable');
  expect(
    screen.getByRole('img', { name: 'pluginStatusDisabled · mcpExtensionToggleUnavailable' }),
  ).toBeTruthy();
  expect(mcpService.probeServer).toHaveBeenCalledWith('extension:personal:demo');
  expect(mcpService.setExtensionServerEnabled).not.toHaveBeenCalled();
  expect(mcpService.setServerEnabled).not.toHaveBeenCalled();
});

test('opens read-only parameters from a disabled MCP card without opening its transport', async () => {
  const server = { ...demoServer('personal', false), connectionSummary: 'node server.mjs' };
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([server]);
  vi.mocked(mcpService.readExtensionSettings).mockResolvedValue({
    success: true,
    value: { server, revision: 'native-revision', definition: null, override: null },
  });
  renderManager();
  fireEvent.click(await screen.findByText(server.name));
  expect(
    ((await screen.findByDisplayValue(server.connectionSummary)) as HTMLTextAreaElement).readOnly,
  ).toBe(true);
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
  fireEvent.click(await findCardProbe());
  vi.mocked(mcpService.loadExtensionServers).mockResolvedValue([demoServer('personal', false)]);
  const changed = vi.mocked(window.electron.extensions.onChanged).mock.calls[0][0];
  await act(async () => {
    changed({ extensionId: 'personal-plugin', enabled: false });
  });
  expect(screen.queryByText('pluginStatusDisabled')).toBeNull();
  expect(
    screen.getByRole('img', { name: 'pluginStatusDisabled · mcpExtensionToggleUnavailable' }),
  ).toBeTruthy();
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
