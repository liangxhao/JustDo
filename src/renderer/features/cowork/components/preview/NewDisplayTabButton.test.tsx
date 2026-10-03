// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import NewDisplayTabButton from './NewDisplayTabButton';

afterEach(cleanup);

test('creates a new tab directly on every click', () => {
  i18nService.setLanguage('en', { persist: false });
  const createTab = vi.fn();
  render(<NewDisplayTabButton onCreateTab={createTab} />);

  const button = screen.getByRole('button', { name: 'New tab' });
  fireEvent.click(button);
  fireEvent.click(button);

  expect(createTab).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('menu')).toBeNull();
});

test('does not create a tab when unavailable or at capacity', () => {
  const createTab = vi.fn();
  render(<NewDisplayTabButton disabled onCreateTab={createTab} />);

  fireEvent.click(screen.getByRole('button'));

  expect(createTab).not.toHaveBeenCalled();
});

test('keeps focus on the new tab address field after creation', () => {
  render(
    <>
      <input aria-label="Browser address" />
      <NewDisplayTabButton
        onCreateTab={() => screen.getByRole('textbox', { name: 'Browser address' }).focus()}
      />
    </>,
  );

  fireEvent.click(screen.getByRole('button'));

  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Browser address' }));
});
