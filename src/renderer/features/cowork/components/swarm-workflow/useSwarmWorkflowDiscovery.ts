import type { SwarmWorkflowResult } from '@shared/cowork/swarmWorkflow';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Observe the selected chat independently of whether its workflow Tab is open. */
export function useSwarmWorkflowDiscovery(
  sessionId: string | null | undefined,
  onDiscover: () => void,
) {
  const seen = useRef(new Map<string, Set<string>>());
  const onDiscoverRef = useRef(onDiscover);
  onDiscoverRef.current = onDiscover;
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    result: SwarmWorkflowResult;
    hasFlows: boolean;
  }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      let result: SwarmWorkflowResult;
      try {
        result = await window.electron.cowork.getSwarmWorkflows(sessionId);
      } catch {
        result = { success: false };
      }
      if (disposed) return;
      setSnapshot(previous => ({
        sessionId,
        result,
        hasFlows: result.success
          ? result.flows.length > 0
          : previous?.sessionId === sessionId && previous.hasFlows,
      }));
      if (result.success) {
        const known = seen.current.get(sessionId);
        const discovered = result.flows.some(
          flow =>
            !known?.has(flow.id) &&
            (known !== undefined || !['completed', 'cancelled'].includes(flow.status)),
        );
        const next = known ?? new Set<string>();
        result.flows.forEach(flow => next.add(flow.id));
        seen.current.set(sessionId, next);
        if (discovered) onDiscoverRef.current();
      }
      timer = setTimeout(() => void read(), 2500);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, revision]);
  const result: SwarmWorkflowResult =
    snapshot && snapshot.sessionId === sessionId ? snapshot.result : { success: false };
  const running =
    result.success && result.flows.some(flow => ['running', 'stopping'].includes(flow.status));
  const hasFlows = snapshot?.sessionId === sessionId && snapshot?.hasFlows === true;
  return { result, running, hasFlows, refresh };
}
