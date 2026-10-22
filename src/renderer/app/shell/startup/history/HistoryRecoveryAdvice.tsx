import { HistoryRecoveryKind, StartupSupportAction } from '@shared/app/startup/history';

import { i18nService } from '@/services/i18n';

import StartupSupportButton from './StartupSupportButton';

export default function HistoryRecoveryAdvice({ kind }: { kind: HistoryRecoveryKind }) {
  const taskManager =
    window.electron.platform === 'win32' &&
    [HistoryRecoveryKind.Busy, HistoryRecoveryKind.Access, HistoryRecoveryKind.Changing].some(
      value => value === kind,
    );
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-medium">{i18nService.t(`initializationRecovery_${kind}`)}</p>
      <p className="mt-2">{i18nService.t(`initializationRecovery_${kind}Description`)}</p>
      {taskManager && (
        <p className="mt-2">{i18nService.t('initializationRecoveryTaskManagerHint')}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <StartupSupportButton
          action={StartupSupportAction.OpenData}
          label="initializationOpenData"
        />
        {taskManager && (
          <StartupSupportButton
            action={StartupSupportAction.OpenTaskManager}
            label="initializationOpenTaskManager"
          />
        )}
      </div>
    </div>
  );
}
