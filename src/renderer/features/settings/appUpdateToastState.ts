import type { AppUpdateState } from '@shared/appUpdate';

export type AppUpdateToastState = {
  state: AppUpdateState;
  installing: boolean;
  installError: boolean;
} | null;

export const selectAppUpdateToastState = (
  current: AppUpdateToastState,
  incoming: AppUpdateState,
  dismissedRevision: number | null,
): AppUpdateToastState => {
  if (current && incoming.revision < current.state.revision) {
    return current;
  }
  if (incoming.phase === 'downloaded') {
    if (
      dismissedRevision === incoming.revision ||
      (current && current.state.revision >= incoming.revision)
    ) {
      return current;
    }
    return { state: incoming, installing: false, installError: false };
  }
  if (incoming.phase === 'error' && current?.installing) {
    return { ...current, installing: false, installError: true };
  }
  return current;
};
