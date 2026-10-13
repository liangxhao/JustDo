import { useEffect, useState } from 'react';
import type { SwarmWorkflowDetail, SwarmWorkflowNode } from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

export interface WorkflowDetailOptions {
  sessionId: string;
  flowId: string;
  node: SwarmWorkflowNode;
  source?: SwarmWorkflowNode;
  active: boolean;
}
export function useWorkflowDetail(
  api: Pick<WorkflowBrowserPorts, 'getSwarmWorkflowDetail'>,
  { sessionId, flowId, node, source, active }: WorkflowDetailOptions,
) {
  const [detail, setDetail] = useState<SwarmWorkflowDetail>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await api.getSwarmWorkflowDetail(sessionId, flowId, node.id, source?.id);
        if (disposed) return;
        setError(!result.success);
        if (result.success) setDetail(result.detail);
      } catch {
        if (!disposed) setError(true);
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 2500);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, flowId, node.id, node.status, source?.id, active, retry]);

  return { detail, error, retry, setRetry };
}
