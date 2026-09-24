// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import PluginGroupSection from './PluginGroupSection';

afterEach(cleanup);

test('keeps a collapsible system group closed until requested', () => {
  render(
    <PluginGroupSection title="System" count={2} collapsible defaultExpanded={false}>
      <span>Bundled plugin</span>
    </PluginGroupSection>,
  );

  const button = screen.getByRole('button', { name: 'pluginGroupExpand' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByText('pluginGroupExpandShort')).toBeTruthy();
  expect(button.className).not.toContain('border');
  expect(screen.getByText('pluginGroupExpandShort').previousElementSibling?.textContent).toBe(
    'System',
  );
  expect(screen.getByText('Bundled plugin').closest('[hidden]')).toBeTruthy();

  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('pluginGroupCollapseShort')).toBeTruthy();
  expect(screen.getByText('Bundled plugin').closest('[hidden]')).toBeNull();
});

test('forces search results open without overwriting the stored collapse preference', () => {
  const { rerender } = render(
    <PluginGroupSection title="System" count={1} collapsible defaultExpanded={false} forceExpanded>
      <span>Matched plugin</span>
    </PluginGroupSection>,
  );

  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('Matched plugin').closest('[hidden]')).toBeNull();

  rerender(
    <PluginGroupSection
      title="System"
      count={1}
      collapsible
      defaultExpanded={false}
      forceExpanded={false}
    >
      <span>Matched plugin</span>
    </PluginGroupSection>,
  );
  expect(screen.getByRole('button', { name: 'pluginGroupExpand' })).toBeTruthy();
  expect(screen.getByText('Matched plugin').closest('[hidden]')).toBeTruthy();
});
