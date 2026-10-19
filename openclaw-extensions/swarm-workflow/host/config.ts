import { OpenClawExtensionId } from '../../runtime-services/contracts/native-ids';

export interface WorkflowHostAgent {
  id: string;
  enabled: boolean;
  deletedAt?: number | null;
}

export const buildManagedSwarmWorkflowPluginEntries = (
  agents: WorkflowHostAgent[],
  isAvailable: (id: string) => boolean,
): Record<string, unknown> =>
  isAvailable(OpenClawExtensionId.SWARM_WORKFLOW)
    ? {
        [OpenClawExtensionId.SWARM_WORKFLOW]: {
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
