import {
  useWorkflowBatch,
  type WorkflowBatchOptions,
} from '../../../../../../plugins/extensions/swarm-workflow/browser/batch';
import {
  useWorkflowDetail,
  type WorkflowDetailOptions,
} from '../../../../../../plugins/extensions/swarm-workflow/browser/detail';
import {
  useWorkflowIntervention,
  type WorkflowInterventionOptions,
} from '../../../../../../plugins/extensions/swarm-workflow/browser/intervention';
import {
  useWorkflowPanel,
  type WorkflowPanelOptions,
} from '../../../../../../plugins/extensions/swarm-workflow/browser/panel';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export const useSwarmWorkflowPanelState = (options: WorkflowPanelOptions) =>
  useWorkflowPanel(workflowBrowserPorts, options);
export const useSwarmWorkflowBatchState = (options: WorkflowBatchOptions) =>
  useWorkflowBatch(workflowBrowserPorts, options);
export const useSwarmWorkflowDetailState = (options: WorkflowDetailOptions) =>
  useWorkflowDetail(workflowBrowserPorts, options);
export const useSwarmWorkflowInterventionState = (options: WorkflowInterventionOptions) =>
  useWorkflowIntervention(workflowBrowserPorts, options);
