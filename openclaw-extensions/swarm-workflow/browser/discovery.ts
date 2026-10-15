import type { WorkflowBrowserPorts, WorkflowAvailability } from './ports';
import type { SwarmWorkflowResult } from '../contracts/workflow';
import { useCallback, useEffect, useRef, useState } from 'react';
import { observeWorkflows } from './observe';

/** Observe the selected chat independently of whether its workflow Tab is open. */
export function useSwarmWorkflowDiscovery(
  api: Pick<WorkflowBrowserPorts, 'getSwarmWorkflows' | 'onSwarmWorkflowsChanged'>,
  sessionId: string | null | undefined,
  onDiscover?: () => void,
  availability: WorkflowAvailability = { enabled: true, disabledRevision: 0 },
) {
  const { enabled, disabledRevision } = availability;
  const seenRevision = useRef(disabledRevision);
  const seen = useRef(new Map<string, Set<string>>());
  const onDiscoverRef = useRef(onDiscover);
  onDiscoverRef.current = onDiscover;
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    disabledRevision: number;
    result: SwarmWorkflowResult;
    hasFlows: boolean;
    count: number;
  }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (seenRevision.current !== disabledRevision) {
      seen.current.clear();
      seenRevision.current = disabledRevision;
    }
    if (!enabled) {
      seen.current.clear();
      setSnapshot(undefined);
      return;
    }
    if (!sessionId) return;
    return observeWorkflows(
      api,
      sessionId,
      result => {
        setSnapshot(previous => ({
          sessionId,
          disabledRevision,
          result,
          hasFlows: result.success
            ? result.flows.length > 0
            : previous?.sessionId === sessionId &&
              previous.disabledRevision === disabledRevision &&
              previous.hasFlows,
          count: result.success
            ? result.flows.length
            : previous?.sessionId === sessionId && previous.disabledRevision === disabledRevision
              ? previous.count
              : 0,
        }));
        if (result.success && onDiscoverRef.current) {
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
      },
      { generation: disabledRevision, refresh: revision > 0 },
    );
  }, [api, sessionId, revision, enabled, disabledRevision]);
  const current =
    enabled &&
    snapshot &&
    snapshot.sessionId === sessionId &&
    snapshot.disabledRevision === disabledRevision
      ? snapshot
      : undefined;
  const result: SwarmWorkflowResult = current ? current.result : { success: false };
  const running =
    result.success && result.flows.some(flow => ['running', 'stopping'].includes(flow.status));
  const hasFlows = current?.hasFlows === true;
  const count = current?.count ?? 0;
  return { result, running, hasFlows, count, refresh };
}
