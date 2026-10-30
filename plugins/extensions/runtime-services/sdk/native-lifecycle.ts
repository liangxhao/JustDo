import { AsyncLocalStorage } from 'node:async_hooks';

export interface NativeRegistrationLifecycle {
  signal?: AbortSignal;
  runInBackgroundContext?: <T>(run: () => T) => T;
}

/** Quiescing can close fresh Native admission before lifecycle abort or disposal. */
function isNativeRegistrationCurrent(lifecycle: NativeRegistrationLifecycle): boolean {
  const { signal, runInBackgroundContext } = lifecycle;
  if (!signal || signal.aborted || !runInBackgroundContext) return false;
  try { return runInBackgroundContext(() => true) === true && !signal.aborted; }
  catch { return false; }
}
/** Capture during registration so a later teardown token cannot admit the probe. */
export function captureNativeRegistrationProbe(lifecycle: NativeRegistrationLifecycle): () => boolean {
  const withinRegistration = AsyncLocalStorage.snapshot();
  return () => withinRegistration(() => isNativeRegistrationCurrent(lifecycle));
}
