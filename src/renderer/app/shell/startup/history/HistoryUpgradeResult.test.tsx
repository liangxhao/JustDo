// @vitest-environment jsdom
import { HistoryRecoveryKind, StartupSupportAction } from '@shared/app/startup/history';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import HistoryRecoveryAdvice from './HistoryRecoveryAdvice';
import HistoryUpgradeResult from './HistoryUpgradeResult';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function bridge() {
  const openSupport = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', initialization: { openSupport } },
  });
  return openSupport;
}
test('shows all recovery outcomes and opens only the fixed backup action before explicit continuation', async () => {
  const openSupport = bridge();
  const onContinue = vi.fn();
  const view = render(
    <HistoryUpgradeResult
      summary={{
        conversations: 291,
        cachedConversations: 53,
        unavailableConversations: 3,
        nativeSessions: 526,
        missingTranscripts: 7,
        unavailableWorkspaces: 12,
      }}
      backupPath="C:/data/backups/history"
      onContinue={onContinue}
    />,
  );
  expect(screen.getByText('291')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.getByText('12')).toBeTruthy();
  const files = screen.getByRole('list', { name: 'initializationProjectRulesFiles' });
  expect(
    within(files)
      .getAllByRole('listitem')
      .map(item => item.textContent),
  ).toEqual([
    'AGENTS.md',
    'BOOT.md',
    'BOOTSTRAP.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    'SOUL.md',
    'TOOLS.md',
    'USER.md',
  ]);
  expect(screen.getByText('initializationProjectRulesAddDescription')).toBeTruthy();
  expect(screen.getByText('initializationProjectRulesReuseDescription')).toBeTruthy();
  expect(screen.getByText('initializationProjectRulesContext')).toBeTruthy();
  expect(screen.getByText('initializationProjectRulesLegacyWarning')).toBeTruthy();
  const details = view.container.querySelector('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('initializationResultDetails'));
  expect(details.open).toBe(true);
  expect(screen.getByText('initializationResultIncomplete')).toBeTruthy();
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'initializationOpenBackup' }));
  await waitFor(() => expect(openSupport).toHaveBeenCalledWith(StartupSupportAction.OpenBackup));
  fireEvent.click(screen.getByRole('button', { name: 'initializationResultContinue' }));
  expect(onContinue).toHaveBeenCalledOnce();
});
test('file lock advice offers manual Task Manager and data-folder actions, with visible launch failures', async () => {
  const openSupport = bridge();
  openSupport.mockResolvedValue({ success: false });
  render(<HistoryRecoveryAdvice kind={HistoryRecoveryKind.Busy} />);
  expect(screen.getByText('initializationRecovery_busyDescription')).toBeTruthy();
  expect(screen.getByText('initializationRecoveryTaskManagerHint')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'initializationOpenTaskManager' }));
  await waitFor(() =>
    expect(openSupport).toHaveBeenCalledWith(StartupSupportAction.OpenTaskManager),
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'initializationOpenData' })).toBeTruthy();
});
test('a full disk explains recovery without offering process termination as its remedy', () => {
  bridge();
  render(<HistoryRecoveryAdvice kind={HistoryRecoveryKind.Space} />);
  expect(screen.getByText('initializationRecovery_spaceDescription')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'initializationOpenTaskManager' })).toBeNull();
});
