import type { SwarmWorkflowOptions } from './options';
import type {
  SwarmWorkflowAction,
  SwarmWorkflowActivityResult,
  SwarmWorkflowBatchOptions,
  SwarmWorkflowBatchPage,
  SwarmWorkflowDetailResult,
  SwarmWorkflowIntervention,
  SwarmWorkflowResult,
  SwarmWorkflowSummaryResult,
} from './workflow';

export type SwarmWorkflowPrepareResult =
  | { success: true; instruction: string }
  | { success: false; reason: 'disabled' | 'plan' | 'unavailable' | 'invalid' };
export interface SwarmWorkflowApi {
  prepareSwarmWorkflow(
    options: SwarmWorkflowOptions,
    sessionId?: string,
  ): Promise<SwarmWorkflowPrepareResult>;
  getSwarmWorkflowBatch(
    sessionId: string,
    flowId: string,
    stageId: string,
    options: SwarmWorkflowBatchOptions,
  ): Promise<{ success: true; page: SwarmWorkflowBatchPage } | { success: false }>;
  retrySwarmWorkflowBatch(
    sessionId: string,
    flowId: string,
    stageId: string,
    revision: number,
    operationId: string,
    itemIds?: string[],
  ): Promise<{ success: boolean; retried?: number; skipped?: number; reasons?: string[] }>;
  interveneSwarmWorkflow(
    sessionId: string,
    flowId: string,
    nodeId: string,
    revision: number,
    intervention: SwarmWorkflowIntervention,
  ): Promise<{ success: boolean }>;
  getSwarmWorkflowDetail(
    sessionId: string,
    flowId: string,
    nodeId: string,
    sourceId?: string,
  ): Promise<SwarmWorkflowDetailResult>;
  getSwarmWorkflows(sessionId: string): Promise<SwarmWorkflowResult>;
  getSwarmWorkflowActivity(): Promise<SwarmWorkflowActivityResult>;
  getSwarmWorkflowSummary(sessionId: string): Promise<SwarmWorkflowSummaryResult>;
  controlSwarmWorkflow(
    sessionId: string,
    id: string,
    revision: number,
    action: SwarmWorkflowAction,
  ): Promise<{ success: boolean }>;
}
