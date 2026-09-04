const STORAGE_KEY = 'justdo-scheduled-task-result-preferences-v1';

export interface ScheduledTaskResultPreferences {
  includeRoutine: boolean;
  includeSystem: boolean;
}

const DEFAULT_PREFERENCES: ScheduledTaskResultPreferences = {
  includeRoutine: false,
  includeSystem: false,
};

export function loadScheduledTaskResultPreferences(): ScheduledTaskResultPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    return {
      includeRoutine: parsed.includeRoutine === true,
      includeSystem: parsed.includeSystem === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveScheduledTaskResultPreferences(
  preferences: ScheduledTaskResultPreferences,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable in restricted renderer contexts. The Redux
    // state still applies the preference for the current application session.
  }
}
