import { useWorkflowBatch, type WorkflowBatchOptions } from '../../browser/batch';
import { useWorkflowDetail, type WorkflowDetailOptions } from '../../browser/detail';
import {
  useWorkflowIntervention,
  type WorkflowInterventionOptions,
} from '../../browser/intervention';
import { useWorkflowPanel, type WorkflowPanelOptions } from '../../browser/panel';
import { workflowBrowserPorts } from './workflowBrowserPorts';

export const useSwarmWorkflowPanelState = (options: WorkflowPanelOptions) =>
  useWorkflowPanel(workflowBrowserPorts, options);
export const useSwarmWorkflowBatchState = (options: WorkflowBatchOptions) =>
  useWorkflowBatch(workflowBrowserPorts, options);
export const useSwarmWorkflowDetailState = (options: WorkflowDetailOptions) =>
  useWorkflowDetail(workflowBrowserPorts, options);
export const useSwarmWorkflowInterventionState = (options: WorkflowInterventionOptions) =>
  useWorkflowIntervention(workflowBrowserPorts, options);
