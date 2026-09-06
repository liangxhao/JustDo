// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import HookManager from './HookManager';

vi.mock('@/features/plugins/components/marketplace/MarketplaceView', () => ({
  default: ({ kind }: { kind: string }) => <div data-testid="hook-marketplace">{kind}</div>,
}));

vi.mock('@/features/plugins/services/hookService', () => ({
  hookService: {
    loadHooks: vi.fn(async () => ({ success: true, hooks: [] })),
    isGatewayOffline: vi.fn(() => false),
    getHooks: vi.fn(() => []),
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'hookMarketplace' ? '市场' : key),
  },
}));

afterEach(() => {
  cleanup();
});

test('keeps the Hook marketplace tab available', async () => {
  expect(translations.zh.hookMarketplace).toBe('市场');
  expect(translations.en.hookMarketplace).toBe('Marketplace');

  render(<HookManager />);

  await waitFor(() => expect(screen.getByText('noHooksAvailable')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '市场' }));

  expect(screen.getByTestId('hook-marketplace').textContent).toBe('hook');
});
