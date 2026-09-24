// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import PluginUpdateIndicator from './PluginUpdateIndicator';

afterEach(cleanup);

test('exposes update availability without adding a colored background', () => {
  render(<PluginUpdateIndicator />);

  const indicator = screen.getByRole('img', { name: 'marketplaceUpdateAvailable' });
  expect(indicator.className).toContain('text-amber');
  expect(indicator.className).not.toContain('bg-amber');
});
