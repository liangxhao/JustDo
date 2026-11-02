// @vitest-environment jsdom

import { PluginKind } from '@shared/plugins/marketplace';
import { PluginOperationAction } from '@shared/plugins/pluginOperation';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mcpService } from '@/features/plugins/mcp/mcpService';
import { startPluginOperation } from '@/features/plugins/shared/pluginOperationService';
import { PluginOperationStatusContent } from '@/features/plugins/shared/PluginOperationStatusSlot';

import PluginsView from './PluginsView';

const engine = vi.hoisted(() => ({ ready: true, pending: false, failed: false }));
const portalAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  useEngineReadiness: () => engine,
}));
vi.mock('@/features/plugins/mcp/mcpService', () => ({
  mcpService: { loadExtensionServers: vi.fn(async () => []) },
}));
vi.mock('@/features/plugins/extensions/ExtensionsManager', () => ({
  default: (props: { searchQuery: string; visibility: string }) => (
    <div data-testid="extensions-manager">
      {JSON.stringify(props)}
      <input aria-label="extension-draft" defaultValue="" />
      <PluginOperationStatusContent>
        <button onClick={portalAction}>extension-portal-action</button>
      </PluginOperationStatusContent>
    </div>
  ),
}));
vi.mock('@/features/plugins/hooks/HookManager', () => ({
  default: () => <div>hooks-manager</div>,
}));
vi.mock('@/features/plugins/mcp/McpManager', () => ({
  default: (props: { onOpenExtension?: (extensionId: string) => void }) => (
    <button type="button" onClick={() => props.onOpenExtension?.('parent-extension')}>
      mcp-manager
    </button>
  ),
}));
vi.mock('@/features/plugins/skills/SkillsManager', () => ({
  default: () => <div>skills-manager</div>,
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

afterEach(cleanup);
beforeEach(() => {
  Object.assign(engine, { ready: true, pending: false, failed: false });
  vi.clearAllMocks();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32' },
  });
});

test('keeps categories accessible while engine preparation defers native inventories', () => {
  Object.assign(engine, { ready: false, pending: true });
  const props = { isSidebarCollapsed: false, onToggleSidebar: vi.fn(), onNewChat: vi.fn() };
  const { rerender } = render(<PluginsView {...props} />);
  const notice = screen.getByText('enginePreparingContent');
  expect(notice.closest('main')).toBeNull();
  expect(notice.closest('.fixed.bottom-4.right-4')).toBeTruthy();
  expect(notice.closest('[role="status"]')?.querySelector('.animate-spin')).toBeTruthy();
  expect(screen.queryByTestId('extensions-manager')).toBeNull();
  expect(mcpService.loadExtensionServers).not.toHaveBeenCalled();
  for (const tab of ['extensions', 'mcpServers', 'hooks', 'skills']) {
    fireEvent.click(screen.getByRole('button', { name: tab }));
    expect(screen.getAllByText('enginePreparingContent')).toHaveLength(1);
    expect(screen.getByText('enginePreparingContent').closest('main')).toBeNull();
  }
  expect(screen.queryByText('skills-manager')).toBeNull();

  Object.assign(engine, { ready: true, pending: false });
  rerender(<PluginsView {...props} />);
  expect(screen.getByText('skills-manager')).toBeTruthy();
  expect(screen.queryByText('enginePreparingContent')).toBeNull();
  expect(mcpService.loadExtensionServers).toHaveBeenCalledOnce();
});

test('shows engine recovery guidance and retains an admitted manager draft through a restart', () => {
  const props = { isSidebarCollapsed: false, onToggleSidebar: vi.fn(), onNewChat: vi.fn() };
  const { rerender } = render(<PluginsView {...props} />);
  const input = screen.getByRole('textbox', { name: 'extension-draft' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'unsaved configuration' } });
  const portalButton = screen.getByRole('button', { name: 'extension-portal-action' });
  fireEvent.click(portalButton);
  expect(portalAction).toHaveBeenCalledOnce();

  Object.assign(engine, { ready: false, pending: false, failed: true });
  rerender(<PluginsView {...props} />);
  const notice = screen.getByText('engineUnavailableContent');
  expect(notice.closest('main')).toBeNull();
  expect(notice.closest('.fixed.bottom-4.right-4')).toBeTruthy();
  expect(notice.closest('[role="status"]')?.querySelector('.animate-spin')).toBeNull();
  expect(input.closest('[inert]')).toBeTruthy();
  fireEvent.click(portalButton);
  expect(portalAction).toHaveBeenCalledOnce();
  const skillsTab = screen.getByRole('button', { name: /skills/ }) as HTMLButtonElement;
  expect(skillsTab.disabled).toBe(true);
  fireEvent.click(skillsTab);
  expect(screen.queryByText('skills-manager')).toBeNull();

  Object.assign(engine, { ready: true, failed: false });
  rerender(<PluginsView {...props} />);
  expect(screen.getByRole('textbox', { name: 'extension-draft' })).toBe(input);
  expect(input.value).toBe('unsaved configuration');
  expect(input.closest('[inert]')).toBeNull();
  fireEvent.click(portalButton);
  expect(portalAction).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('engineUnavailableContent')).toBeNull();
});

test('shares the progress stack during an engine restart without losing the active operation', () => {
  const operation = startPluginOperation({
    kind: PluginKind.EXTENSION,
    action: PluginOperationAction.UPDATE,
    label: 'Updating extension',
  });
  const props = { isSidebarCollapsed: false, onToggleSidebar: vi.fn(), onNewChat: vi.fn() };
  const { rerender } = render(<PluginsView {...props} />);
  Object.assign(engine, { ready: false, pending: true });
  rerender(<PluginsView {...props} />);
  const stack = screen.getByText('Updating extension').closest('.fixed');
  expect(screen.getByText('enginePreparingContent').closest('.fixed')).toBe(stack);
  Object.assign(engine, { ready: true, pending: false });
  rerender(<PluginsView {...props} />);
  expect(screen.queryByText('enginePreparingContent')).toBeNull();
  expect(screen.getByText('Updating extension').closest('.fixed')).toBe(stack);
  act(() => operation.finish());
  expect(screen.queryByText('Updating extension')).toBeNull();
});

test('uses one capability switcher instead of separate installed and marketplace pages', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32' },
  });
  render(<PluginsView isSidebarCollapsed={false} onToggleSidebar={vi.fn()} onNewChat={vi.fn()} />);

  expect(screen.queryByRole('button', { name: 'pluginHubAllTypes' })).toBeNull();
  expect(screen.getByTestId('extensions-manager').textContent).toContain('"visibility":"all"');
  fireEvent.click(screen.getByRole('button', { name: /skills/ }));
  expect(screen.getByText('skills-manager')).toBeTruthy();
  expect(screen.queryByTestId('extensions-manager')).toBeNull();
  expect(screen.queryByRole('button', { name: 'skillInstalled' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'skillMarketplace' })).toBeNull();
});

test('keeps the implicit all-status view while sharing search with the active manager', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32' },
  });
  render(<PluginsView isSidebarCollapsed={false} onToggleSidebar={vi.fn()} onNewChat={vi.fn()} />);

  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'writer' } });

  expect(screen.getByTestId('extensions-manager').textContent).toBe(
    '{"searchQuery":"writer","visibility":"all"}',
  );
  expect(screen.queryByRole('button', { name: 'pluginHubStatus.all' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'pluginHubStatus.installed' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'pluginHubStatus.available' })).toBeNull();
});

test('opens a provider extension from a contributed child capability', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32' },
  });
  render(<PluginsView isSidebarCollapsed={false} onToggleSidebar={vi.fn()} onNewChat={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /mcpServers/ }));
  fireEvent.click(screen.getByRole('button', { name: 'mcp-manager' }));

  expect(screen.getByTestId('extensions-manager').textContent).toContain(
    '"requestedExtensionId":"parent-extension"',
  );
});
