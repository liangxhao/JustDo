import { useEffect, useRef, useState } from 'react';
import type {
  SwarmWorkflowAction,
  SwarmWorkflowResult,
  SwarmWorkflowView,
} from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

export interface WorkflowPanelOptions {
  sessionId: string;
  active: boolean;
  snapshot?: SwarmWorkflowResult;
  onRefresh?: () => void;
  resetViewport: () => void;
}
export function useWorkflowPanel(
  api: Pick<WorkflowBrowserPorts, 'getSwarmWorkflows' | 'controlSwarmWorkflow'>,
  { sessionId, active, snapshot, onRefresh, resetViewport }: WorkflowPanelOptions,
) {
  const [flows, setFlows] = useState<SwarmWorkflowView[]>([]);
  const [chosen, setChosen] = useState<string>();
  const seenFlows = useRef(new Set<string>());
  const [selected, setSelected] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, refresh] = useState(0);

  useEffect(() => {
    seenFlows.current = new Set();
    setFlows([]);
    setChosen(undefined);
    setSelected(undefined);
    setSelectedEdge(undefined);
    setError(false);
    resetViewport();
  }, [sessionId, resetViewport]);
  useEffect(() => {
    const discovered = flows.find(flow => !seenFlows.current.has(flow.id));
    flows.forEach(flow => seenFlows.current.add(flow.id));
    if (discovered) {
      setChosen(discovered.id);
      setSelected(undefined);
      setSelectedEdge(undefined);
      resetViewport();
    }
  }, [flows, resetViewport]);
  useEffect(() => {
    if (!active || snapshot !== undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await api.getSwarmWorkflows(sessionId);
        if (disposed) return;
        if (result.success) {
          setFlows(result.flows);
          setStale(false);
        } else setStale(true);
      } catch {
        if (!disposed) setStale(true);
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 2500);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, active, revision, snapshot]);
  useEffect(() => {
    if (snapshot === undefined) return;
    if (snapshot.success) {
      setFlows(snapshot.flows);
      setStale(false);
    } else setStale(true);
  }, [snapshot]);
  const refreshFlows = () => {
    if (onRefresh) onRefresh();
    else refresh(v => v + 1);
  };
  const flow = flows.find(f => f.id === chosen) ?? flows[0];

  const node = flow?.nodes.find(n => n.id === selected);
  const source = flow?.nodes.find(n => n.id === selectedEdge);
  const actions = flow?.actions ?? {
    pause: flow?.status === 'running',
    resume:
      flow?.status === 'paused' &&
      !flow.nodes.some(item => ['failed', 'uncertain'].includes(item.status)),
    stop: !!flow && !['completed', 'cancelled', 'stopping'].includes(flow.status),
    retry: flow?.canRetry ?? false,
  };
  const control = async (action: SwarmWorkflowAction) => {
    if (!flow || busy || stale || !actions[action]) return;
    setBusy(true);
    setError(false);
    try {
      const result = await api.controlSwarmWorkflow(sessionId, flow.id, flow.revision, action);
      setError(!result.success);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      refreshFlows();
    }
  };

  const selectFlow = (id: string) => {
    setChosen(id);
    resetViewport();
    setSelected(undefined);
    setSelectedEdge(undefined);
  };
  return {
    flows,
    flow,
    node,
    source,
    selected,
    stale,
    busy,
    error,
    actions,
    control,
    refreshFlows,
    selectFlow,
    setSelected,
    setSelectedEdge,
  };
}
