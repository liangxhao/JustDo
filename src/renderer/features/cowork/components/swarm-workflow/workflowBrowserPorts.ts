import type { WorkflowBrowserPorts } from '../../../../../../openclaw-extensions/swarm-workflow/browser/ports';

// Resolve the live preload bridge on each call rather than retaining a controller or connection.
export const workflowBrowserPorts: WorkflowBrowserPorts = {
  getSwarmWorkflows: (...args) => window.electron.cowork.getSwarmWorkflows(...args),
  controlSwarmWorkflow: (...args) => window.electron.cowork.controlSwarmWorkflow(...args),
  getSwarmWorkflowDetail: (...args) => window.electron.cowork.getSwarmWorkflowDetail(...args),
  interveneSwarmWorkflow: (...args) => window.electron.cowork.interveneSwarmWorkflow(...args),
  getSwarmWorkflowBatch: (...args) => window.electron.cowork.getSwarmWorkflowBatch(...args),
  retrySwarmWorkflowBatch: (...args) => window.electron.cowork.retrySwarmWorkflowBatch(...args),
  newOperationId: () => crypto.randomUUID(),
};
