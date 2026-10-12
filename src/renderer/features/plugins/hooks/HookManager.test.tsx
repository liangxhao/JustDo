// @vitest-environment jsdom

import { getHookManagement } from '@shared/plugins/management';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { HookEntry } from './hook';
import HookManager from './HookManager';
import { hookService } from './hookService';

vi.mock('@/features/plugins/hooks/hookService', () => ({
  hookService: {
    loadHooks: vi.fn(async () => ({ success: true, hooks: [] })),
    isGatewayOffline: vi.fn(() => false),
    getHooks: vi.fn(() => []),
    deleteHook: vi.fn(),
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'hookDeleteSuccess' ? 'Hook "{name}" deleted' : key),
    getLanguage: () => 'en',
  },
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks: [] });
});

test('keeps Hooks local without exposing an unsupported marketplace', async () => {
  render(<HookManager />);

  await waitFor(() => expect(screen.getByText('noHooksAvailable')).toBeTruthy());
  expect(screen.queryByText('hookMarketplace')).toBeNull();
});

test('confirms custom Hook deletion and removes its row without an unavailable warning', async () => {
  const hook: HookEntry = {
    id: 'custom-hook',
    name: 'custom-hook',
    description: 'Custom Hook',
    enabled: true,
    eligible: true,
    requirementsSatisfied: true,
    loadable: true,
    source: 'openclaw-managed',
    managedByPlugin: false,
    events: ['command:new'],
    missing: { bins: [], env: [], config: [], os: [] },
    ...getHookManagement({ source: 'openclaw-managed' }),
  };
  vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks: [hook] });
  vi.mocked(hookService.deleteHook).mockResolvedValue({ success: true, hooks: [] });
  render(<HookManager />);

  fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: custom-hook' }));
  fireEvent.click(screen.getByRole('button', { name: 'deleteHook' }));
  fireEvent.click(screen.getByRole('button', { name: 'delete' }));

  await screen.findByText('Hook "custom-hook" deleted');
  expect(screen.queryByText('custom-hook')).toBeNull();
  expect(screen.queryByText('hookDeleteFailed')).toBeNull();
  expect(screen.queryByText(/unavailable/i)).toBeNull();
  expect(hookService.deleteHook).toHaveBeenCalledWith('custom-hook');
});

test('shows imported extension Hooks in the user section and bundled extension Hooks in the collapsed system section', async () => {
  const hooks: HookEntry[] = ['personal', 'system'].map(scope => ({
    id: `${scope}-hook`,
    name: `${scope}-hook`,
    description: 'Demo hook',
    enabled: true,
    eligible: true,
    requirementsSatisfied: true,
    loadable: true,
    source: 'openclaw-plugin',
    managedByPlugin: true,
    pluginId: `${scope}-plugin`,
    events: ['command:new'],
    missing: { bins: [], env: [], config: [], os: [] },
    ...getHookManagement({
      managedByPlugin: true,
      pluginId: `${scope}-plugin`,
      pluginScope: scope as 'personal' | 'system',
    }),
  }));
  vi.mocked(hookService.loadHooks).mockResolvedValue({ success: true, hooks });
  render(<HookManager />);
  await screen.findByText('personal-hook');
  const userSection = screen.getByText('pluginGroup.user.label').closest('section')!;
  const systemSection = screen.getByText('pluginGroup.system.label').closest('section')!;
  expect(within(userSection).getByText('personal-hook').closest('[hidden]')).toBeNull();
  expect(within(userSection).queryByText('system-hook')).toBeNull();
  expect(within(userSection).queryByRole('switch')).toBeNull();
  expect(
    within(userSection).getByLabelText('pluginStatusEnabled · hookManagedByPlugin'),
  ).toBeTruthy();
  const expand = within(systemSection).getByRole('button', { expanded: false });
  fireEvent.click(expand);
  expect(within(systemSection).getByText('system-hook').closest('[hidden]')).toBeNull();
});
