import type { SwarmWorkflowResult } from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

type WorkflowObservationPorts = Pick<
  WorkflowBrowserPorts,
  'getSwarmWorkflows' | 'onSwarmWorkflowsChanged'
>;

/** Subscribe before reading; serialize reads and catch changes arriving during a request. */
export function observeWorkflows(
  api: WorkflowObservationPorts,
  sessionId: string,
  receive: (result: SwarmWorkflowResult) => void,
): () => void {
  let disposed = false;
  let reading = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const revisions = new Map<string, number>();
  const schedule = () => {
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
    let result: SwarmWorkflowResult;
    try {
      result = await api.getSwarmWorkflows(sessionId);
    } catch {
      result = { success: false };
    }
    reading = false;
    if (disposed) return;
    if (!dirty) {
      if (result.success) {
        for (const flow of result.flows) {
          revisions.set(flow.id, Math.max(flow.revision, revisions.get(flow.id) ?? 0));
        }
      }
      receive(result);
    }
    if (dirty) schedule();
  };
  const unsubscribe = api.onSwarmWorkflowsChanged(event => {
    if (event.sessionId && event.sessionId !== sessionId) return;
    if (event.sessionId) {
      if (event.revision <= (revisions.get(event.flowId) ?? 0)) return;
      revisions.set(event.flowId, event.revision);
    } else revisions.clear();
    schedule();
  });
  void read();
  return () => {
    disposed = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
