// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import StartupLogButton from './StartupLogButton';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(cleanup);

test('opens existing Main-owned logs and reports an unsuccessful attempt', async () => {
  const openFolder = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', { configurable: true, value: { log: { openFolder } } });
  render(<StartupLogButton />);
  fireEvent.click(screen.getByRole('button', { name: 'startupOpenLogs' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'startupOpenLogsFailed');
  fireEvent.click(screen.getByRole('button', { name: 'startupOpenLogs' }));
  expect(openFolder).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});
