import type { AppUpdateState } from '@shared/app/appUpdate';

export const selectNewerAppUpdateState = (
  current: AppUpdateState,
  candidate: AppUpdateState,
): AppUpdateState => (candidate.revision >= current.revision ? candidate : current);
