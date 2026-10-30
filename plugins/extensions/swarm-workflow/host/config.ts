import { SWARM_WORKFLOW_PLUGIN_ID } from '../contracts/workflow';

export interface WorkflowHostAgent {
  id: string;
  enabled: boolean;
  deletedAt?: number | null;
}

export const buildManagedSwarmWorkflowPluginEntries = (
  agents: WorkflowHostAgent[],
  isAvailable: (id: string) => boolean,
): Record<string, unknown> =>
  isAvailable(SWARM_WORKFLOW_PLUGIN_ID)
    ? {
        [SWARM_WORKFLOW_PLUGIN_ID]: {
          config: {
            availableAgentIds: [
              ...new Set([
                'main',
                ...agents.filter(agent => agent.enabled && !agent.deletedAt).map(agent => agent.id),
              ]),
            ],
          },
        },
      }
    : {};
