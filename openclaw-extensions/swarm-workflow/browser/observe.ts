import type { SwarmWorkflowChangedEvent, SwarmWorkflowEventsApi } from '../contracts/events';
import type { SwarmWorkflowView } from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

type Result<T> = ({ success: true } & T) | { success: false };
type Observer<T> = {
  listeners: Set<(result: Result<T>) => void>;
  snapshot?: Result<T>;
  lastSuccess?: { success: true } & T;
  observedAt: number;
  dispose: () => void;
  refresh: () => void;
};
type Registry<T> = {
  sessions: Map<string, Observer<T>>;
  events: Set<(event: SwarmWorkflowChangedEvent) => void>;
  unsubscribe?: () => void;
  pendingReads: Set<() => void>;
  activeReads: number;
};
const OBSERVATION_REUSE_MS = 1_000;
const MAX_CONCURRENT_READS = 4;
const MAX_READ_RETRIES = 3;

function drainReads<T>(registry: Registry<T>): void {
  while (registry.activeReads < MAX_CONCURRENT_READS && registry.pendingReads.size) {
    const start = registry.pendingReads.values().next().value!;
    registry.pendingReads.delete(start);
    start();
  }
}

function enqueueRead<T>(registry: Registry<T>, read: () => Promise<Result<T>>) {
  let finish!: (result: Result<T> | undefined) => void;
  const result = new Promise<Result<T> | undefined>(resolve => {
    finish = resolve;
  });
  const start = () => {
    registry.activeReads += 1;
    let request: Promise<Result<T>>;
    try {
      request = read();
    } catch {
      request = Promise.resolve({ success: false });
    }
    void request
      .catch((): Result<T> => ({ success: false }))
      .then(finish)
      .finally(() => {
        registry.activeReads -= 1;
        drainReads(registry);
      });
  };
  registry.pendingReads.add(start);
  drainReads(registry);
  return {
    result,
    cancel: () => {
      if (registry.pendingReads.delete(start)) finish(undefined);
    },
  };
}

/** Share reads within one projection, without confusing metadata with full workflow graphs. */
export function createWorkflowObserver<P extends SwarmWorkflowEventsApi, T>(
  readSnapshot: (api: P, sessionId: string) => Promise<Result<T>>,
  flowRevisions: (snapshot: T) => readonly { id: string; revision: number }[] = () => [],
) {
  const registries = new WeakMap<P, Registry<T>>();
  return (
    api: P,
    sessionId: string,
    receive: (result: Result<T>) => void,
    options: { generation?: number; refresh?: boolean } = {},
  ): (() => void) => {
    const key = JSON.stringify([sessionId, options.generation ?? 0]);
    let registry = registries.get(api);
    if (!registry) {
      registry = {
        sessions: new Map(),
        events: new Set(),
        pendingReads: new Set(),
        activeReads: 0,
      };
      registries.set(api, registry);
    }
    let observer = registry.sessions.get(key);
    if (!observer) {
      observer = { listeners: new Set(), observedAt: 0, dispose: () => {}, refresh: () => {} };
      registry.sessions.set(key, observer);
      const current = observer;
      const observation = startObservation(
        api,
        registry,
        sessionId,
        () => readSnapshot(api, sessionId),
        flowRevisions,
        result => {
          current.snapshot = result;
          if (result.success) current.lastSuccess = result;
          current.observedAt = Date.now();
          for (const listener of current.listeners) listener(result);
        },
      );
      current.dispose = observation.dispose;
      current.refresh = observation.refresh;
    } else if (
      options.refresh ||
      observer.snapshot?.success === false ||
      (observer.snapshot && Date.now() - observer.observedAt >= OBSERVATION_REUSE_MS)
    ) {
      observer.refresh();
    }
    observer.listeners.add(receive);
    if (observer.snapshot?.success === false && observer.lastSuccess) receive(observer.lastSuccess);
    if (observer.snapshot) receive(observer.snapshot);
    const current = observer;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      current.listeners.delete(receive);
      if (current.listeners.size) return;
      current.dispose();
      if (registry.sessions.get(key) === current) registry.sessions.delete(key);
    };
  };
}

/** Subscribe before reading; serialize reads and discard snapshots invalidated in flight. */
function startObservation<T>(
  api: SwarmWorkflowEventsApi,
  registry: Registry<T>,
  sessionId: string,
  readSnapshot: () => Promise<Result<T>>,
  flowRevisions: (snapshot: T) => readonly { id: string; revision: number }[],
  receive: (result: Result<T>) => void,
): { dispose: () => void; refresh: () => void } {
  let disposed = false;
  let reading = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelPendingRead: (() => void) | undefined;
  let retries = 0;
  const revisions = new Map<string, number>();
  const schedule = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retries = 0;
    dirty = true;
    if (disposed || reading || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void read();
    }, 50);
  };
  const read = async () => {
    if (disposed) return;
    reading = true;
    dirty = false;
    const request = enqueueRead(registry, readSnapshot);
    cancelPendingRead = request.cancel;
    const result = await request.result;
    cancelPendingRead = undefined;
    reading = false;
    if (disposed || !result) return;
    if (!dirty) {
      if (result.success) {
        retries = 0;
        for (const flow of flowRevisions(result)) {
          revisions.set(flow.id, Math.max(flow.revision, revisions.get(flow.id) ?? 0));
        }
      }
      receive(result);
    }
    if (dirty) schedule();
    else if (!result.success && retries < MAX_READ_RETRIES) {
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          void read();
        },
        1_000 * 2 ** retries++,
      );
    }
  };
  const onEvent = (event: SwarmWorkflowChangedEvent) => {
    if (sessionId && event.sessionId && event.sessionId !== sessionId) return;
    if (event.sessionId) {
      if (event.revision <= (revisions.get(event.flowId) ?? 0)) return;
      revisions.set(event.flowId, event.revision);
    } else revisions.clear();
    schedule();
  };
  registry.events.add(onEvent);
  registry.unsubscribe ??= api.onSwarmWorkflowsChanged(event => {
    for (const listener of registry.events) listener(event);
  });
  void read();
  return {
    refresh: schedule,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      cancelPendingRead?.();
      registry.events.delete(onEvent);
      if (!registry.events.size) {
        registry.unsubscribe?.();
        registry.unsubscribe = undefined;
      }
    },
  };
}

type WorkflowObservationPorts = Pick<
  WorkflowBrowserPorts,
  'getSwarmWorkflows' | 'onSwarmWorkflowsChanged'
>;
export const observeWorkflows = createWorkflowObserver<
  WorkflowObservationPorts,
  { flows: SwarmWorkflowView[]; running?: boolean }
>(
  (api, sessionId) => api.getSwarmWorkflows(sessionId),
  snapshot => snapshot.flows,
);
