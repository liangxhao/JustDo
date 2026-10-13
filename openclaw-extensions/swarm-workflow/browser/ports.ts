import type { SwarmWorkflowApi } from '../contracts/api';

/** Browser-side access to product IPC is injected; implementations never read window.electron. */
export type WorkflowBrowserPorts = Omit<SwarmWorkflowApi, 'prepareSwarmWorkflow'> & {
  newOperationId(): string;
};
export interface WorkflowAvailability {
  enabled: boolean;
  disabledRevision: number;
}
