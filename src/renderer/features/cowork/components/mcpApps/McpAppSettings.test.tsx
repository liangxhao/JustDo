// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { type AppSettings, McpAppSettings } from './McpAppSettings';

afterEach(cleanup);
const settings: AppSettings = {
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', title: 'Limit', minimum: 1, maximum: 100 },
      enabled: { type: 'boolean', title: 'Enabled' },
    },
    required: ['limit'],
  },
  values: { limit: 25, enabled: true },
};

test('allows replacing a numeric draft and saves only the changed numeric value', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  render(
    <McpAppSettings settings={settings} busy={false} save={save} tool={vi.fn()} cancel={vi.fn()} />,
  );
  const number = screen.getByRole('spinbutton', { name: 'Limit' });
  fireEvent.change(number, { target: { value: '' } });
  expect((number as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(number, { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledWith({ limit: 7 });
});

test('cancels a local draft without writing settings', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  const cancel = vi.fn();
  render(
    <McpAppSettings settings={settings} busy={false} save={save} tool={vi.fn()} cancel={cancel} />,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

test('keeps an unset optional numeric property absent while saving another field', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  const optional: AppSettings = {
    ...settings,
    schema: { ...settings.schema, required: [] },
    values: { enabled: true },
  };
  render(
    <McpAppSettings settings={optional} busy={false} save={save} tool={vi.fn()} cancel={vi.fn()} />,
  );
  expect((screen.getByRole('spinbutton', { name: 'Limit' }) as HTMLInputElement).required).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledWith({ enabled: false });
});
