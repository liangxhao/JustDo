// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mcpService } from '@/features/plugins/mcp/mcpService';

import PluginsView from './PluginsView';

const engine = vi.hoisted(() => ({ ready: true, pending: false, failed: false }));
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
  expect(screen.getByRole('status').textContent).toBe('enginePreparingContent');
  expect(screen.queryByTestId('extensions-manager')).toBeNull();
  expect(mcpService.loadExtensionServers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /skills/ }));
  expect(screen.queryByText('skills-manager')).toBeNull();

  Object.assign(engine, { ready: true, pending: false });
  rerender(<PluginsView {...props} />);
  expect(screen.getByText('skills-manager')).toBeTruthy();
  expect(mcpService.loadExtensionServers).toHaveBeenCalledOnce();
});

test('shows engine recovery guidance and retains an admitted manager draft through a restart', () => {
  const props = { isSidebarCollapsed: false, onToggleSidebar: vi.fn(), onNewChat: vi.fn() };
  const { rerender } = render(<PluginsView {...props} />);
  const input = screen.getByRole('textbox', { name: 'extension-draft' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'unsaved configuration' } });

  Object.assign(engine, { ready: false, pending: false, failed: true });
  rerender(<PluginsView {...props} />);
  expect(screen.getByRole('status').textContent).toBe('engineUnavailableContent');
  expect(input.closest('[inert]')).toBeTruthy();
  const skillsTab = screen.getByRole('button', { name: /skills/ }) as HTMLButtonElement;
  expect(skillsTab.disabled).toBe(true);
  fireEvent.click(skillsTab);
  expect(screen.queryByText('skills-manager')).toBeNull();

  Object.assign(engine, { ready: true, failed: false });
  rerender(<PluginsView {...props} />);
  expect(screen.getByRole('textbox', { name: 'extension-draft' })).toBe(input);
  expect(input.value).toBe('unsaved configuration');
  expect(input.closest('[inert]')).toBeNull();
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
