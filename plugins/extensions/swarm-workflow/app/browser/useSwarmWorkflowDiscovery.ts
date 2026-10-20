import { useSwarmWorkflowDiscovery as usePluginDiscovery } from '../../browser/discovery';
import type { WorkflowAvailability } from '../../browser/ports';
import { useWorkflowVisibility } from '../../browser/visibility';
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
