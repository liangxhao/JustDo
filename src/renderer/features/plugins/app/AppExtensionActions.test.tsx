// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AppView } from './browserRegistry';

const fixture = vi.hoisted(() => ({ views: [] as AppView[] }));
vi.mock('./AppCodeReviewAction', () => ({ default: () => null }));
vi.mock('./AppPluginSlot', () => ({
  useAppViews: (slot: string, pluginId: string) =>
    fixture.views.filter(view => view.slot === slot && view.pluginId === pluginId),
  AppPluginSlot: () => null,
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

import AppExtensionActions from './AppExtensionActions';

beforeEach(() => {
  fixture.views = ['plugin.settings', 'plugin.history'].map(slot => ({
    pluginId: 'example',
    epoch: 'one',
    id: slot,
    slot,
    labelKey: slot,
    component: () => null,
  }));
});
afterEach(cleanup);

test('cards retain compact history-before-settings icons and withdraw both actions', () => {
  const open = vi.fn();
  const view = render(<AppExtensionActions extensionId="example" onOpen={open} />);
  const buttons = screen.getAllByRole('button');
  expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
    'plugin.history',
    'plugin.settings',
  ]);
  expect(buttons.every(button => button.textContent === '' && button.querySelector('svg'))).toBe(
    true,
  );
  fireEvent.click(buttons[0]);
  expect(open).toHaveBeenCalledWith({
    pluginId: 'example',
    epoch: 'one',
    id: 'plugin.history',
    slot: 'plugin.history',
  });
  fixture.views = [];
  view.rerender(<AppExtensionActions extensionId="example" onOpen={open} />);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('details retain visible action labels, with the history clock preceding settings', () => {
  render(<AppExtensionActions extensionId="example" variant="details" onOpen={vi.fn()} />);
  const [history, settings] = screen.getAllByRole('button');
  expect(history.textContent).toBe('plugin.history');
  expect(history.querySelector('svg')).toBeTruthy();
  expect(settings.textContent).toBe('plugin.settings');
  expect(settings.querySelector('svg')).toBeNull();
});
