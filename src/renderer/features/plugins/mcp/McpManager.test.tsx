// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { getExtensionProvidedManagement } from '@shared/plugins/management';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    onConfigSyncStart: vi.fn(() => () => undefined),
    onConfigSyncDone: vi.fn(() => () => undefined),
  },
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

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
