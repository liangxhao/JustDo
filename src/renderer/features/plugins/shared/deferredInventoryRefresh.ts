import {
  getEngineReadinessSnapshot,
  subscribeEngineReadiness,
} from '@/app/shell/startup/routing/useEngineReadiness';

/** Coalesce background invalidations while the engine is preparing; only resume reads. */
export function observeDeferredInventoryRefresh(refresh: () => void) {
  let pending = false;
  let live = true;
  let wasReady = getEngineReadinessSnapshot().ready;
  const request = () => {
    if (!live) return;
    if (!getEngineReadinessSnapshot().ready) {
      pending = true;
      return;
    }
    pending = false;
    refresh();
  };
  const stop = subscribeEngineReadiness(() => {
    const ready = getEngineReadinessSnapshot().ready;
    if (ready && (pending || !wasReady)) request();
    wasReady = ready;
  });
  return {
    request,
    dispose: () => {
      live = false;
      stop();
    },
  };
}
