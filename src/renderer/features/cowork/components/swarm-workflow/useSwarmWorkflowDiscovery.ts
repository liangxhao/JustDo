import { useSwarmWorkflowDiscovery as usePluginDiscovery } from '../../../../../../openclaw-extensions/swarm-workflow/browser/discovery';
import type { WorkflowAvailability } from '../../../../../../openclaw-extensions/swarm-workflow/browser/ports';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export function useSwarmWorkflowDiscovery(
  sessionId: string | null | undefined,
  onDiscover?: () => void,
  availability?: WorkflowAvailability,
) {
  return usePluginDiscovery(workflowBrowserPorts, sessionId, onDiscover, availability);
}
