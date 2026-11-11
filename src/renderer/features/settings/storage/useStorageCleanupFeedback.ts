import {
  type StorageCleanupKind,
  StorageCleanupPhase,
  type StorageCleanupProgress,
} from '@shared/storage/storageDirectory';
import { useEffect, useRef, useState } from 'react';

export const StorageCleanupView = {
  Confirm: 'confirm', Working: 'working', Refreshing: 'refreshing', Result: 'result',
} as const;
type View = (typeof StorageCleanupView)[keyof typeof StorageCleanupView];
type Outcome = { success: boolean; error?: string; scanFailed: boolean; unknown: boolean };
const activePhases = new Set<string>([
  StorageCleanupPhase.Preparing, StorageCleanupPhase.Checking, StorageCleanupPhase.Clearing,
]);

/** Progress is presentation only. The mutation's own response is the sole result authority. */
export function useStorageCleanupFeedback(kind: StorageCleanupKind) {
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<View>();
  const [progress, setProgress] = useState<StorageCleanupProgress>();
  const [progressUnavailable, setProgressUnavailable] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const working = view === StorageCleanupView.Working;
  const running = working || view === StorageCleanupView.Refreshing;

  useEffect(() => {
    if (!working || !window.electron.storageDirectory.cleanupStatus) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let operationId: string | undefined;
    const poll = async () => {
      try {
        const result = await window.electron.storageDirectory.cleanupStatus();
        if (cancelled) return;
        if (result.success) {
          const next = result.value;
          if (next?.kind === kind && activePhases.has(next.phase) &&
              (!operationId || operationId === next.operationId)) {
            operationId = next.operationId;
            setProgress(next);
          }
          setProgressUnavailable(false);
        } else setProgressUnavailable(true);
      } catch { if (!cancelled) setProgressUnavailable(true); }
      if (!cancelled) timer = setTimeout(() => void poll(), 400);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [working, kind]);

  useEffect(() => {
    if (!running) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);

  return {
    visible, view, progress, progressUnavailable, outcome, elapsed, running,
    confirm: () => { setOutcome(undefined); setView(StorageCleanupView.Confirm); setVisible(true); },
    begin: () => {
      startedAt.current = Date.now();
      setElapsed(0);
      setProgress(undefined);
      setProgressUnavailable(false);
      setOutcome(undefined);
      setView(StorageCleanupView.Working);
      setVisible(true);
    },
    refreshing: () => setView(StorageCleanupView.Refreshing),
    finish: (success: boolean, error?: string, scanFailed = false, unknown = false) => {
      setOutcome({ success, error, scanFailed, unknown });
      setView(StorageCleanupView.Result);
    },
    reveal: () => setVisible(true),
    close: () => { setVisible(false); if (!running) setView(undefined); },
  };
}

export type StorageCleanupFeedback = ReturnType<typeof useStorageCleanupFeedback>;
