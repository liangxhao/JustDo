import type {
  ScheduledTask,
  SystemTaskSettings,
  SystemTaskSettingsPatch,
} from '@shared/scheduledTask/types';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isMemoryDreamingTask } from './utils';

// Renderer-only feature card: never persisted or sent to a cron mutation API.
export const MEMORY_DREAMING_CARD_ID = 'memory-dreaming-feature';
export function withMemoryDreamingCard(
  tasks: ScheduledTask[],
  settings: SystemTaskSettings | null,
): ScheduledTask[] {
  if (!settings) return tasks;
  const enabled = settings.memoryAvailable && settings.memoryDreamingEnabled;
  if (tasks.some(isMemoryDreamingTask))
    return tasks.map(task =>
      isMemoryDreamingTask(task) ? { ...task, enabled: enabled && task.enabled } : task,
    );
  return [
    ...tasks,
    {
      id: MEMORY_DREAMING_CARD_ID,
      name: '',
      description: '',
      enabled,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: {
        kind: 'agentTurn',
        message: '__openclaw_memory_core_short_term_promotion_dream__',
      },
      management: 'managed',
      delivery: { mode: 'none' },
      agentId: null,
      sessionKey: null,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: '',
      updatedAt: '',
    },
  ];
}

export function useMemoryDreamingControl(tasks: ScheduledTask[]) {
  const [settings, setSettings] = useState<SystemTaskSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const mutationPending = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    let disposed = false;
    void window.electron.scheduledTasks
      .getSystemSettings()
      .then(result => {
        if (disposed || mutationPending.current || current !== generation.current) return;
        if (!result.success || !result.settings) {
          setFailed(true);
          return;
        }
        setSettings(result.settings);
        setFailed(false);
      })
      .catch(() => {
        if (!disposed && current === generation.current) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [tasks]);
  const update = useCallback(
    async (patch: SystemTaskSettingsPatch) => {
      if (mutationPending.current || !settings) return false;
      mutationPending.current = true;
      ++generation.current;
      setBusy(true);
      try {
        const result = await window.electron.scheduledTasks.updateSystemSettings(patch);
        if (!result.success) throw new Error('Could not change system task settings');
        ++generation.current;
        setSettings(current => current && { ...current, ...patch });
        setFailed(false);
        return true;
      } finally {
        mutationPending.current = false;
        setBusy(false);
      }
    },
    [settings],
  );
  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!settings?.memoryAvailable) return false;
      return update({ memoryDreamingEnabled: enabled });
    },
    [settings, update],
  );
  const toggleSkills = useCallback(
    async (enabled: boolean) => {
      return update({ skillMode: enabled ? 'auto' : 'off' });
    },
    [update],
  );
  return { settings, busy, failed, toggle, toggleSkills };
}
