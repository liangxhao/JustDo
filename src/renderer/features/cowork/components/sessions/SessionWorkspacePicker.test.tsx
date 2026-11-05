// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';

import SessionWorkspacePicker from './SessionWorkspacePicker';

vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: {
    getRecentCwds: vi.fn().mockResolvedValue(['C:/next']),
    setSessionWorkspace: vi.fn(),
  },
}));

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, 'electron', { configurable: true, value: { platform: 'win32' } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('explains directory semantics and submits a recent folder with the original cwd', async () => {
  vi.mocked(coworkService.setSessionWorkspace).mockResolvedValue({ success: true, cwd: 'C:/next' });
  render(<SessionWorkspacePicker sessionId="session" cwd="C:/old" disabled={false} />);
  await act(async () => fireEvent.click(screen.getByLabelText('Change working directory')));
  expect(screen.getByText(i18nService.t('sessionWorkspaceDescription'))).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByTitle('C:/next')));
  expect(coworkService.setSessionWorkspace).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'session',
    cwd: 'C:/next',
    expectedCwd: 'C:/old',
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('disables directory changes while execution is active', () => {
  render(<SessionWorkspacePicker sessionId="session" cwd="C:/old" disabled />);
  const button = screen.getByLabelText('Change working directory') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(coworkService.setSessionWorkspace).not.toHaveBeenCalled();
});
