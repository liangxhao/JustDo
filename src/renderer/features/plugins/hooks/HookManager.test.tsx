// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import HookManager from './HookManager';

vi.mock('@/features/plugins/hooks/hookService', () => ({
  hookService: {
    loadHooks: vi.fn(async () => ({ success: true, hooks: [] })),
    isGatewayOffline: vi.fn(() => false),
    getHooks: vi.fn(() => []),
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

afterEach(() => {
  cleanup();
});

test('keeps Hooks local without exposing an unsupported marketplace', async () => {
  render(<HookManager />);

  await waitFor(() => expect(screen.getByText('noHooksAvailable')).toBeTruthy());
  expect(screen.queryByText('hookMarketplace')).toBeNull();
});
