import { useEffect, useMemo, useState } from 'react';

import { createWorkflowObserver } from '../../../../../../openclaw-extensions/swarm-workflow/browser/observe';
import type {
  WorkflowAvailability,
  WorkflowBrowserPorts,
} from '../../../../../../openclaw-extensions/swarm-workflow/browser/ports';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export { isSwarmWorkflowActive } from '../../../../../../openclaw-extensions/swarm-workflow/contracts/workflow';

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
) {
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    return observeActivity(
      workflowBrowserPorts,
      '',
      result => {
        if (result.success) setRunning(new Set(result.sessionIds));
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
