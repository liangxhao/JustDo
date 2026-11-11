import { StorageCleanupKind, StorageDirectoryError } from '@shared/storage/storageDirectory';
import { useEffect, useRef, useState } from 'react';

import { useStorageCleanupFeedback } from './useStorageCleanupFeedback';

export function useBrowserCacheCleanup({ disabled, onSettled }: {
  disabled: boolean;
  onSettled: (success: boolean) => Promise<boolean | void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(false);
  const inFlight = useRef(false);
  const feedback = useStorageCleanupFeedback(StorageCleanupKind.Cache);
  const available = typeof window.electron.storageDirectory.clearBrowserCache === 'function';
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const clear = async () => {
    if (inFlight.current) { feedback.reveal(); return; }
    if (!available || disabled) return;
    feedback.confirm();
  };
  const confirm = async () => {
    if (!available || disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    feedback.begin();
    try {
      let success = false;
      let errorCode: string | undefined;
      let unknown = false;
      try {
        const result = await window.electron.storageDirectory.clearBrowserCache();
        success = result.success;
        if (!result.success) errorCode = result.code;
      } catch { errorCode = StorageDirectoryError.Unavailable; unknown = true; }
      if (!alive.current) return;
      if (!success) setError(errorCode);
      feedback.refreshing();
      let scanFailed = false;
      try { scanFailed = await onSettled(success) === false; }
      catch { scanFailed = true; }
      if (alive.current) feedback.finish(success, errorCode, scanFailed, unknown);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { available, busy, error, clear, confirm, feedback };
}

export type BrowserCacheController = ReturnType<typeof useBrowserCacheCleanup>;
