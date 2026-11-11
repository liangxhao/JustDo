import { StorageDirectoryError, type UpgradeBackupStatus } from '@shared/storage/storageDirectory';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Keep the operation alive while its statistics row disappears during a refresh. */
export function useUpgradeBackup({ disabled, onSettled }: {
  disabled: boolean;
  onSettled: (success: boolean) => Promise<boolean | void>;
}) {
  const [status, setStatus] = useState<UpgradeBackupStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const alive = useRef(false);
  const inFlight = useRef(false);
  const statusRevision = useRef(0);
  const readStatus = useCallback(async () => {
    const api = window.electron.storageDirectory;
    if (!alive.current || !api.upgradeBackupStatus) return;
    const revision = ++statusRevision.current;
    try {
      const result = await api.upgradeBackupStatus();
      if (!alive.current || revision !== statusRevision.current) return;
      if (result.success) {
        setStatus(result.value);
        setStatusFailed(false);
      } else {
        setStatus(current => current && { ...current, canDelete: false });
        setStatusFailed(true);
      }
    } catch {
      if (!alive.current || revision !== statusRevision.current) return;
      setStatus(current => current && { ...current, canDelete: false });
      setStatusFailed(true);
    }
  }, []);
  const refreshStatus = useCallback(async () => {
    if (!inFlight.current) await readStatus();
  }, [readStatus]);
  useEffect(() => {
    alive.current = true;
    void refreshStatus();
    return () => { alive.current = false; statusRevision.current += 1; };
  }, [refreshStatus]);

  const remove = async () => {
    if (inFlight.current || disabled || !status?.canDelete) return;
    inFlight.current = true;
    statusRevision.current += 1;
    setBusy(true);
    setError(undefined);
    setOutcomeUnknown(false);
    try {
      let success = false;
      let errorCode: string | undefined;
      try {
        const result = await window.electron.storageDirectory.deleteUpgradeBackup();
        if (!alive.current) return;
        if (!result.success && result.code === StorageDirectoryError.Cancelled) {
          await readStatus();
          return;
        }
        success = result.success;
        if (!result.success) errorCode = result.code;
      } catch {
        errorCode = StorageDirectoryError.Unavailable;
        if (alive.current) setOutcomeUnknown(true);
      }
      if (!alive.current) return;
      statusRevision.current += 1;
      if (success) {
        setStatus({ exists: false, canDelete: false });
      } else {
        setError(errorCode);
        await readStatus();
      }
      if (!alive.current) return;
      await onSettled(success);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { status, busy, error, outcomeUnknown, statusFailed, remove, refreshStatus };
}

export type UpgradeBackupController = ReturnType<typeof useUpgradeBackup>;
