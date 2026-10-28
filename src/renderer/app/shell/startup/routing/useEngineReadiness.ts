import { AppInitializationPhase, type AppInitializationState, AppInitializationTask, type AppInitializationTaskStatus } from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { captureStartupFailure, type StartupFailure, StartupFailureSource } from '@shared/app/startupFailure';
import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { useSyncExternalStore } from 'react';

export type EngineReadinessSnapshot = {
  ready: boolean;
  pending: boolean;
  failed: boolean;
  status: OpenClawEngineStatus | null;
  failure: StartupFailure | null;
  integrationsStatus?: AppInitializationTaskStatus;
};

const UNKNOWN: EngineReadinessSnapshot = {
  ready: false, pending: true, failed: false, status: null, failure: null,
};
const listeners = new Set<() => void>();
let snapshot = UNKNOWN;
let initialization: AppInitializationState | null = null;
let status: OpenClawEngineStatus | null = null;
let stateReadFailure: StartupFailure | null = null;
let engineReadFailure: StartupFailure | null = null;
let release: (() => void) | undefined;
let refresh: (() => Promise<void>) | undefined;

function publish(): void {
  const failure = initialization?.enginePreparationFailure ??
    (initialization?.phase === AppInitializationPhase.Failed ? initialization.failure : undefined) ??
    stateReadFailure ?? engineReadFailure;
  const failed = Boolean(failure) || status?.phase === EnginePhase.Error ||
    initialization?.phase === AppInitializationPhase.Failed;
  const admitted = initialization?.phase === AppInitializationPhase.Ready &&
    (initialization.route !== StartupRoute.Normal || initialization.enginePreparationPending === false);
  const ready = admitted && !failed && status?.phase === EnginePhase.Running;
  const pending = !failed && !ready && (
    !initialization || !status || initialization.phase === AppInitializationPhase.Preparing ||
    initialization.enginePreparationPending === true || status.phase === EnginePhase.Starting ||
    status.phase === EnginePhase.Running
  );
  snapshot = { ready, pending, failed, status, failure,
    integrationsStatus: initialization?.tasks?.[AppInitializationTask.Integrations] };
  listeners.forEach(listener => listener());
}

/** One read-only projection of Main's startup admission and live process status. */
function observe(): () => void {
  const startup = window.electron?.initialization;
  const engine = window.electron?.openclaw?.engine;
  let live = true;
  let stateRevision = 0;
  let engineRevision = 0;
  const unsubscribers: (() => void)[] = [];
  const failedRead = (owner: 'state' | 'engine', error: unknown) => {
    if (!live) return;
    const failure = captureStartupFailure(StartupFailureSource.Renderer, error, {
      activity: 'engineReadiness',
    });
    if (owner === 'state') stateReadFailure = failure;
    else engineReadFailure = failure;
    publish();
  };
  if (startup?.onChanged) unsubscribers.push(startup.onChanged(next => {
    if (!live) return;
    stateRevision += 1;
    initialization = next;
    stateReadFailure = null;
    publish();
  }));
  if (engine?.onProgress) unsubscribers.push(engine.onProgress(next => {
    if (!live) return;
    engineRevision += 1;
    status = next;
    engineReadFailure = null;
    publish();
  }));
  const readState = (): Promise<void> => {
    if (!startup?.getState) return Promise.resolve();
    const reading = ++stateRevision;
    return startup.getState().then(next => {
      if (!live || reading !== stateRevision) return;
      initialization = next;
      stateReadFailure = null;
      publish();
    }).catch(error => {
      if (reading === stateRevision) failedRead('state', error);
    });
  };
  const readStatus = (): Promise<void> => {
    if (!engine?.getStatus) return Promise.resolve();
    const reading = ++engineRevision;
    return engine.getStatus().then(result => {
      if (!live || reading !== engineRevision) return;
      if (!result.success || !result.status) {
        failedRead('engine', result.error || 'Engine status unavailable');
        return;
      }
      status = result.status;
      engineReadFailure = null;
      publish();
    }).catch(error => {
      if (reading === engineRevision) failedRead('engine', error);
    });
  };
  refresh = async () => { await Promise.all([readState(), readStatus()]); };
  void refresh();
  return () => {
    live = false;
    refresh = undefined;
    unsubscribers.forEach(unsubscribe => unsubscribe());
  };
}

export function getEngineReadinessSnapshot(): EngineReadinessSnapshot {
  return snapshot;
}

/** A successful retry may verify an already running process without a process event. */
export function refreshEngineReadiness(): Promise<void> {
  return refresh?.() ?? Promise.resolve();
}

export function subscribeEngineReadiness(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) release = observe();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    release?.();
    release = undefined;
    initialization = null;
    status = null;
    stateReadFailure = null;
    engineReadFailure = null;
    snapshot = UNKNOWN;
  };
}

export function useEngineReadiness(): EngineReadinessSnapshot {
  return useSyncExternalStore(subscribeEngineReadiness, getEngineReadinessSnapshot);
}
