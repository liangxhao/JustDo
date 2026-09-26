// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import UsageAndStorageSettings from './UsageAndStorageSettings';

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./UsageStatsTab', () => ({ default: () => <div>usage content</div> }));
vi.mock('./SessionStorageCard', () => ({
  default: function MockSessionStorageCard() {
    useEffect(() => {
      lifecycle.mounted();
      return () => lifecycle.unmounted();
    }, []);
    return <div>storage content</div>;
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('opens usage by default and releases storage on switching away', () => {
  render(<UsageAndStorageSettings />);
  expect(screen.getByRole('tabpanel').textContent).toBe('usage content');
  expect(lifecycle.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'storageTitle' }));
  expect(screen.getByRole('tabpanel').textContent).toBe('storage content');
  expect(lifecycle.mounted).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'usageStats' }));
  expect(lifecycle.unmounted).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('storage content')).toBeNull();
});

it('supports keyboard navigation and associates the active tab with its panel', () => {
  render(<UsageAndStorageSettings />);
  const usage = screen.getByRole('tab', { name: 'usageStats' });
  const storage = screen.getByRole('tab', { name: 'storageTitle' });
  fireEvent.keyDown(usage, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(storage);
  expect(storage.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(storage.id);
  fireEvent.keyDown(storage, { key: 'Home' });
  expect(document.activeElement).toBe(usage);
  expect(usage.getAttribute('aria-selected')).toBe('true');
});
