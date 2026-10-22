import { useEffect, useRef, useState } from 'react';

import type { SwarmWorkflowDetail, SwarmWorkflowNode } from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

export interface WorkflowDetailOptions {
  sessionId: string;
  flowId: string;
  node: SwarmWorkflowNode;
  source?: SwarmWorkflowNode;
  active: boolean;
  revision?: number;
}
export function useWorkflowDetail(
  api: Pick<WorkflowBrowserPorts, 'getSwarmWorkflowDetail' | 'onSwarmWorkflowsChanged'>,
  { sessionId, flowId, node, source, active, revision }: WorkflowDetailOptions,
) {
  const [detail, setDetail] = useState<SwarmWorkflowDetail>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const revalidate = useRef<(() => void) | undefined>();
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let reading = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      reading = true;
      dirty = false;
      let status = node.status;
      try {
        const result = await api.getSwarmWorkflowDetail(sessionId, flowId, node.id, source?.id);
        if (disposed || dirty) return;
        setError(!result.success);
        if (result.success) {
          status = result.detail.status ?? node.status;
          setDetail(result.detail);
        }
      } catch {
        if (!disposed && !dirty) setError(true);
      } finally {
        reading = false;
        if (!disposed && dirty) refreshDetail();
        else if (!disposed && !['done', 'failed', 'cancelled'].includes(status))
          timer = setTimeout(() => void read(), 2500);
      }
    };
    const refreshDetail = () => {
      if (disposed) return;
      clearTimeout(timer);
      if (reading) {
        dirty = true;
        return;
      }
      timer = setTimeout(read, 0);
    };
    revalidate.current = refreshDetail;
    const unsubscribe = api.onSwarmWorkflowsChanged(event => {
      // A reconnect can restore the same flow revision after a failed read.
      if (!event.sessionId) refreshDetail();
    });
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      if (revalidate.current === refreshDetail) revalidate.current = undefined;
    };
  }, [api, sessionId, flowId, node.id, node.status, source?.id, active, retry]);
  useEffect(() => {
    if (seenRevision.current !== revision) revalidate.current?.();
    seenRevision.current = revision;
  }, [revision]);

  return { detail, error, retry, setRetry };
}
