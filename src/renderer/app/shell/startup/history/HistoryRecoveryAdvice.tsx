import { type HistoryLockDiagnostic, HistoryRecoveryKind, StartupSupportAction } from '@shared/app/startup/history';

import { i18nService } from '@/services/i18n';

import StartupSupportButton from './StartupSupportButton';

export default function HistoryRecoveryAdvice({ kind, database = false, diagnostic }: {
  kind: HistoryRecoveryKind;
  database?: boolean;
  diagnostic?: HistoryLockDiagnostic;
}) {
  const prefix = database ? 'initializationDatabaseRecovery' : 'initializationRecovery';
  const taskManager =
    window.electron.platform === 'win32' &&
    [HistoryRecoveryKind.Busy, HistoryRecoveryKind.Access, HistoryRecoveryKind.Changing].some(
      value => value === kind,
    );
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-medium">{i18nService.t(`${prefix}_${kind}`)}</p>
      <p className="mt-2">{i18nService.t(`${prefix}_${kind}Description`)}</p>
      {diagnostic && (
        <div className="mt-3 border-t border-amber-200/70 pt-3 dark:border-amber-900">
          <p className="font-medium">{i18nService.t('initializationLockDiagnosticTitle')}</p>
          <p className="mt-1 break-all font-mono text-xs leading-5">{diagnostic.targetPath}</p>
          {diagnostic.available && diagnostic.processes.length > 0 ? (
            <>
              <p className="mt-2">{i18nService.t('initializationLockDiagnosticObserved')}</p>
              <ul className="mt-2 space-y-1.5" aria-label={i18nService.t('initializationLockProcesses')}>
                {diagnostic.processes.map(owner => (
                  <li key={owner.pid} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/60 px-3 py-2 dark:bg-black/15">
                    <span className="min-w-0 break-all font-medium">{owner.name}</span>
                    <span className="whitespace-nowrap font-mono text-xs">{i18nService.t('initializationLockProcessPid')} {owner.pid}</span>
                    {owner.isMainProcess && (
                      <span className="rounded border border-amber-300 px-1.5 text-xs dark:border-amber-800">
                        {i18nService.t('initializationLockCurrentApplication')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {diagnostic.processes.some(owner => owner.isMainProcess) && (
                <p className="mt-2">{i18nService.t('initializationLockCurrentApplicationHint')}</p>
              )}
            </>
          ) : (
            <p className="mt-2">
              {i18nService.t(diagnostic.available ? 'initializationLockDiagnosticEmpty' : 'initializationLockDiagnosticUnavailable')}
            </p>
          )}
        </div>
      )}
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
