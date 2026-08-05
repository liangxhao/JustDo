import type { AppUpdateState } from '@shared/appUpdate';

export const selectNewerAppUpdateState = (
  current: AppUpdateState,
  candidate: AppUpdateState,
): AppUpdateState => (candidate.revision >= current.revision ? candidate : current);
