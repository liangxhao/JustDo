import { ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

import type { UpgradeBackupController } from './useUpgradeBackup';

export default function UpgradeBackupControls({ backup, disabled }: {
  backup: UpgradeBackupController;
  disabled: boolean;
}) {
  const t = (key: string) => i18nService.t(key);
  if (!backup.busy && !backup.status?.exists) return null;
  const label = t(backup.busy ? 'storageDirectoryDeletingBackup' : 'storageDirectoryDeleteBackup');
  return (
    <button type="button" onClick={() => void backup.remove()}
      disabled={backup.busy || disabled || !backup.status?.canDelete}
      aria-label={label}
      aria-busy={backup.busy}
      title={backup.busy || backup.status?.canDelete ? label : t('upgradeBackupBlocked')}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-transparent text-red-600 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-300 dark:hover:text-red-200">
      {backup.busy ? (
        <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <TrashIcon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
