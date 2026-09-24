// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import PluginsView from './PluginsView';

vi.mock('@/app/shell/window/WindowTitleBar', () => ({
  default: () => null,
}));
vi.mock('@/features/plugins/extensions/ExtensionsManager', () => ({
  default: (props: { searchQuery: string; visibility: string }) => (
    <div data-testid="extensions-manager">{JSON.stringify(props)}</div>
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
