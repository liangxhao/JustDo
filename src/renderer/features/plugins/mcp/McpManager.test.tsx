// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { getExtensionProvidedManagement } from '@shared/plugins/management';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ExtensionProvidedMcpServer } from './mcp';
import McpManager from './McpManager';
import { mcpService } from './mcpService';
import mcpReducer from './mcpSlice';

vi.mock('@/features/plugins/marketplace/MarketplaceView', () => ({ default: () => null }));
vi.mock('./mcpService', () => ({
  mcpService: {
    loadServers: vi.fn(async () => []),
    loadExtensionServers: vi.fn(async () => []),
    getExtensionServers: vi.fn(() => null),
    probeServer: vi.fn(),
    onConfigSyncStart: vi.fn(() => () => undefined),
    onConfigSyncDone: vi.fn(() => () => undefined),
  },
}));
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
  vi.mocked(mcpService.loadServers).mockResolvedValue([]);
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
