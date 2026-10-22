import { useSwarmWorkflowDiscovery as usePluginDiscovery } from '../../../../../../plugins/extensions/swarm-workflow/browser/discovery';
import type { WorkflowAvailability } from '../../../../../../plugins/extensions/swarm-workflow/browser/ports';
import { useWorkflowVisibility } from '../../../../../../plugins/extensions/swarm-workflow/browser/visibility';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export function useSwarmWorkflowDiscovery(
  sessionId: string | null | undefined,
  onDiscover?: () => void,
  availability?: WorkflowAvailability,
  active = false,
) {
  const visible = useWorkflowVisibility(document);
  return usePluginDiscovery(
    workflowBrowserPorts,
    sessionId,
    onDiscover,
    availability,
    active && visible,
  );
}
