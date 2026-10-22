export const WorkflowEventName = {
  Changed: 'changed',
  Reset: 'reset',
} as const;

export const SwarmWorkflowGatewayEvent = {
  Changed: `plugin.swarm-workflow.${WorkflowEventName.Changed}`,
  Reset: `plugin.swarm-workflow.${WorkflowEventName.Reset}`,
} as const;

export interface WorkflowNativeChange {
  parentKey: string;
  flowId: string;
  revision: number;
}

/** A reset has no session identity and invalidates the selected chat after recovery. */
export type SwarmWorkflowChangedEvent =
  | { sessionId: string; flowId: string; revision: number }
  | { sessionId?: undefined; flowId?: undefined; revision?: undefined };

export interface SwarmWorkflowEventsApi {
  onSwarmWorkflowsChanged(callback: (event: SwarmWorkflowChangedEvent) => void): () => void;
}

export function isWorkflowNativeChange(value: unknown): value is WorkflowNativeChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.parentKey === 'string' &&
    item.parentKey.length > 0 &&
    item.parentKey.length <= 512 &&
    typeof item.flowId === 'string' &&
    item.flowId.length > 0 &&
    item.flowId.length <= 80 &&
    Number.isSafeInteger(item.revision) &&
    Number(item.revision) > 0
  );
}
