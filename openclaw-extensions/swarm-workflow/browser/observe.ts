import type { SwarmWorkflowResult } from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';
import type { SwarmWorkflowChangedEvent } from '../contracts/events';

type WorkflowObservationPorts = Pick<
  WorkflowBrowserPorts,
  'getSwarmWorkflows' | 'onSwarmWorkflowsChanged'
>;

type WorkflowObserver = {
  listeners: Set<(result: SwarmWorkflowResult) => void>;
  snapshot?: SwarmWorkflowResult;
  lastSuccess?: Extract<SwarmWorkflowResult, { success: true }>;
  observedAt: number;
  dispose: () => void;
  refresh: () => void;
};
type WorkflowRegistry = {
  sessions: Map<string, WorkflowObserver>;
  events: Set<(event: SwarmWorkflowChangedEvent) => void>;
  unsubscribe?: () => void;
  pendingReads: Set<() => void>;
  activeReads: number;
};
const observers = new WeakMap<WorkflowObservationPorts, WorkflowRegistry>();
const OBSERVATION_REUSE_MS = 1_000;
const MAX_CONCURRENT_READS = 4;
const MAX_READ_RETRIES = 3;

function drainReads(registry: WorkflowRegistry): void {
  while (registry.activeReads < MAX_CONCURRENT_READS && registry.pendingReads.size) {
    const start = registry.pendingReads.values().next().value!;
    registry.pendingReads.delete(start);
    start();
  }
}

function enqueueRead(registry: WorkflowRegistry, read: () => Promise<SwarmWorkflowResult>) {
  let finish!: (result: SwarmWorkflowResult | undefined) => void;
  const result = new Promise<SwarmWorkflowResult | undefined>(resolve => {
    finish = resolve;
  });
  const start = () => {
    registry.activeReads += 1;
    let request: Promise<SwarmWorkflowResult>;
    try {
      request = read();
    } catch {
      request = Promise.resolve({ success: false });
    }
    void request
      .catch((): SwarmWorkflowResult => ({ success: false }))
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

function subscribeEvents(
  api: WorkflowObservationPorts,
  registry: WorkflowRegistry,
  receive: (event: SwarmWorkflowChangedEvent) => void,
): () => void {
  registry.events.add(receive);
  registry.unsubscribe ??= api.onSwarmWorkflowsChanged(event => {
    for (const listener of registry.events) listener(event);
  });
  return () => {
    registry.events.delete(receive);
    if (registry.events.size) return;
    registry.unsubscribe?.();
    registry.unsubscribe = undefined;
  };
}

/** Share the same native snapshot between sidebar, discovery and workflow Tab. */
export function observeWorkflows(
  api: WorkflowObservationPorts,
  sessionId: string,
  receive: (result: SwarmWorkflowResult) => void,
  options: { generation?: number; refresh?: boolean } = {},
): () => void {
  const key = JSON.stringify([sessionId, options.generation ?? 0]);
  let registry = observers.get(api);
  if (!registry) {
    registry = { sessions: new Map(), events: new Set(), pendingReads: new Set(), activeReads: 0 };
    observers.set(api, registry);
  }
  const sessions = registry.sessions;
  let observer = sessions.get(key);
  if (!observer) {
    observer = { listeners: new Set(), observedAt: 0, dispose: () => {}, refresh: () => {} };
    sessions.set(key, observer);
    const current = observer;
    const observation = startObservation(api, registry, sessionId, result => {
      current.snapshot = result;
      if (result.success) current.lastSuccess = result;
      current.observedAt = Date.now();
      for (const listener of current.listeners) listener(result);
    });
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
    if (sessions.get(key) === current) sessions.delete(key);
  };
}

/** Subscribe before reading; serialize reads and catch changes arriving during a request. */
function startObservation(
  api: WorkflowObservationPorts,
  registry: WorkflowRegistry,
  sessionId: string,
  receive: (result: SwarmWorkflowResult) => void,
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
    const request = enqueueRead(registry, () => api.getSwarmWorkflows(sessionId));
    cancelPendingRead = request.cancel;
    const result = await request.result;
    cancelPendingRead = undefined;
    reading = false;
    if (disposed || !result) return;
    if (!dirty) {
      if (result.success) {
        retries = 0;
        for (const flow of result.flows) {
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
  const unsubscribe = subscribeEvents(api, registry, event => {
    if (event.sessionId && event.sessionId !== sessionId) return;
    if (event.sessionId) {
      if (event.revision <= (revisions.get(event.flowId) ?? 0)) return;
      revisions.set(event.flowId, event.revision);
    } else revisions.clear();
    schedule();
  });
  void read();
  return {
    refresh: schedule,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      cancelPendingRead?.();
      unsubscribe();
    },
  };
}
