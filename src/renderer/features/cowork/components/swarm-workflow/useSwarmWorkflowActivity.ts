import { useEffect, useRef, useState } from 'react';

import { observeWorkflows } from '../../../../../../openclaw-extensions/swarm-workflow/browser/observe';
import type { WorkflowAvailability } from '../../../../../../openclaw-extensions/swarm-workflow/browser/ports';
import { isSwarmWorkflowActive } from '../../../../../../openclaw-extensions/swarm-workflow/contracts/workflow';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export { isSwarmWorkflowActive };

/** Sidebar activity is display metadata and never participates in send admission. */
export function useSwarmWorkflowActivity(
  sessionIds: readonly string[],
  { enabled, disabledRevision }: WorkflowAvailability,
) {
  const sessionIdsKey = JSON.stringify(
    [...new Set(sessionIds)].filter(id => !id.startsWith('temp-')).sort(),
  );
  const [activity, setActivity] = useState<Readonly<Record<string, boolean>>>({});
  const observations = useRef({
    generation: disabledRevision,
    subscriptions: new Map<string, () => void>(),
  });
  useEffect(() => {
    const observed = observations.current;
    if (!enabled || observed.generation !== disabledRevision) {
      observed.subscriptions.forEach(stop => stop());
      observed.subscriptions.clear();
      observed.generation = disabledRevision;
    }
    const ids = JSON.parse(sessionIdsKey) as string[];
    const retained = new Set(ids);
    for (const [sessionId, stop] of observed.subscriptions) {
      if (retained.has(sessionId)) continue;
      stop();
      observed.subscriptions.delete(sessionId);
    }
    // Disabling the plugin does not prove its admitted native workers ended.
    // Keep last-known activity until a fresh enabled observation can settle it.
    setActivity(previous => Object.fromEntries(ids.map(id => [id, previous[id] === true])));
    if (!enabled) return;
    for (const sessionId of ids) {
      if (observed.subscriptions.has(sessionId)) continue;
      const stop = observeWorkflows(
        workflowBrowserPorts,
        sessionId,
        result => {
          if (!result.success) return;
          // A truncated history can prove activity but cannot prove idle when
          // an older runtime has not supplied the all-history summary yet.
          const running =
            result.running ?? (result.flows.some(isSwarmWorkflowActive) ? true : undefined);
          if (running === undefined) return;
          setActivity(previous =>
            previous[sessionId] === running ? previous : { ...previous, [sessionId]: running },
          );
        },
        { generation: disabledRevision },
      );
      observed.subscriptions.set(sessionId, stop);
    }
  }, [sessionIdsKey, enabled, disabledRevision]);
  useEffect(() => {
    const subscriptions = observations.current.subscriptions;
    return () => {
      subscriptions.forEach(stop => stop());
      subscriptions.clear();
    };
  }, []);
  return activity;
}
