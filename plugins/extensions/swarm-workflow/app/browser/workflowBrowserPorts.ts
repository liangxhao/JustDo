import type { AppBrowserHost } from '@app-plugin/sdk/browser';
import type { WorkflowBrowserPorts } from '../../browser/ports';
import { WorkflowEventName } from '../../contracts/events';

let current: AppBrowserHost | undefined;
export const bindBrowserHost = (host: AppBrowserHost): (() => void) => {
  current = host;
  return () => {
    if (current === host) current = undefined;
  };
};
const invoke = <T>(command: string, ...args: unknown[]): Promise<T> => {
  if (!current || current.signal.aborted) return Promise.reject(new Error('appPluginUnavailable'));
  return current.invoke<T>(command, ...args);
};
export const workflowBrowserPorts: WorkflowBrowserPorts = {
  onSwarmWorkflowsChanged: callback => {
    if (!current || current.signal.aborted) return () => undefined;
    return current.onEvent(WorkflowEventName.Changed, callback);
  },
  getSwarmWorkflows: (...args) => invoke('workflow.list', ...args),
  getSwarmWorkflowActivity: () => invoke('workflow.activity'),
  getSwarmWorkflowSummary: (...args) => invoke('workflow.summary', ...args),
  controlSwarmWorkflow: (...args) => invoke('workflow.control', ...args),
  getSwarmWorkflowDetail: (...args) => invoke('workflow.detail', ...args),
  interveneSwarmWorkflow: (...args) => invoke('workflow.intervene', ...args),
  getSwarmWorkflowBatch: (...args) => invoke('workflow.batch', ...args),
  retrySwarmWorkflowBatch: (...args) => invoke('workflow.retry-batch', ...args),
  newOperationId: () => crypto.randomUUID(),
};
export const history = (input: Record<string, unknown>) => current?.renderHistory(input) ?? null;
