import type { SwarmWorkflowApi } from '../contracts/api';
import type { SwarmWorkflowEventsApi } from '../contracts/events';

/** Browser-side access to product IPC is injected; implementations never read window.electron. */
export type WorkflowBrowserPorts = Omit<SwarmWorkflowApi, 'prepareSwarmWorkflow'> &
  SwarmWorkflowEventsApi & {
    newOperationId(): string;
  };
export interface WorkflowAvailability {
  enabled: boolean;
  disabledRevision: number;
}
