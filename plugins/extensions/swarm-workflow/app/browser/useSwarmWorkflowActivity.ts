import { useEffect, useMemo, useRef, useState } from 'react';

import { createWorkflowObserver } from '../../browser/observe';
import type {
  WorkflowAvailability,
  WorkflowBrowserPorts,
} from '../../browser/ports';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export { isSwarmWorkflowActive } from '../../contracts/workflow';

type ActivityPorts = Pick<
  WorkflowBrowserPorts,
  'getSwarmWorkflowActivity' | 'onSwarmWorkflowsChanged'
>;
const observeActivity = createWorkflowObserver<ActivityPorts, { sessionIds: string[] }>(api =>
  api.getSwarmWorkflowActivity(),
);

/** One compact native snapshot for the sidebar; never read each conversation's history. */
export function useSwarmWorkflowActivity(
  sessionIds: readonly string[],
  { enabled, disabledRevision }: WorkflowAvailability,
  onConfirmedSnapshot?: (sessionIds: readonly string[]) => void,
) {
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const confirmed = useRef(onConfirmedSnapshot);
  confirmed.current = onConfirmedSnapshot;
  useEffect(() => {
    if (!enabled) return;
    return observeActivity(
      workflowBrowserPorts,
      '',
      result => {
        if (result.success) {
          confirmed.current?.(result.sessionIds);
          setRunning(new Set(result.sessionIds));
        }
      },
      { generation: disabledRevision },
    );
  }, [enabled, disabledRevision]);
  const idsKey = JSON.stringify(
    [...new Set(sessionIds)].filter(id => !id.startsWith('temp-')).sort(),
  );
  return useMemo<Readonly<Record<string, boolean>>>(
    () => Object.fromEntries((JSON.parse(idsKey) as string[]).map(id => [id, running.has(id)])),
    [idsKey, running],
  );
}
