import { useCallback, useEffect, useRef, useState } from 'react';

import type { SwarmWorkflowSummary, SwarmWorkflowSummaryResult } from '../contracts/workflow';
import { createWorkflowObserver } from './observe';
import type { WorkflowAvailability, WorkflowBrowserPorts } from './ports';

type SummaryPorts = Pick<
  WorkflowBrowserPorts,
  'getSwarmWorkflowSummary' | 'onSwarmWorkflowsChanged'
>;
const observeSummary = createWorkflowObserver<SummaryPorts, SwarmWorkflowSummary>(
  (api, sessionId) => api.getSwarmWorkflowSummary(sessionId),
);

/** Summary metadata is read only while the selected chat's summary is visible. */
export function useSwarmWorkflowDiscovery(
  api: SummaryPorts,
  sessionId: string | null | undefined,
  onDiscover?: () => void,
  availability: WorkflowAvailability = { enabled: true, disabledRevision: 0 },
  active = false,
) {
  const { enabled, disabledRevision } = availability;
  const callback = useRef(onDiscover);
  callback.current = onDiscover;
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    generation: number;
    result: SwarmWorkflowSummaryResult;
    count: number;
  }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) {
      setSnapshot(undefined);
      return;
    }
    if (!sessionId || !active) return;
    return observeSummary(
      api,
      sessionId,
      result => {
        setSnapshot(previous => ({
          sessionId,
          generation: disabledRevision,
          result,
          count: result.success
            ? result.count
            : previous?.sessionId === sessionId && previous.generation === disabledRevision
              ? previous.count
              : 0,
        }));
      },
      { generation: disabledRevision, refresh: revision > 0 },
    );
  }, [api, sessionId, enabled, disabledRevision, active, revision]);
  const current =
    enabled &&
    snapshot &&
    snapshot.sessionId === sessionId &&
    snapshot.generation === disabledRevision
      ? snapshot
      : undefined;
  const result: SwarmWorkflowSummaryResult = current?.result ?? { success: false };
  const count = current?.count ?? 0;
  const successful = result.success;
  const running = result.success && result.running;
  const discovered = useRef({ generation: disabledRevision, counts: new Map<string, number>() });
  useEffect(() => {
    if (discovered.current.generation !== disabledRevision) {
      discovered.current = { generation: disabledRevision, counts: new Map() };
    }
    if (!active || !sessionId || !successful) return;
    const known = discovered.current.counts.get(sessionId);
    if (count > (known ?? 0) && (known !== undefined || running)) callback.current?.();
    discovered.current.counts.set(sessionId, count);
  }, [active, sessionId, disabledRevision, count, successful, running]);
  return { result, count, hasFlows: count > 0, running, refresh };
}
