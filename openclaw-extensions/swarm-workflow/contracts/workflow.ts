import {
  FLOW_LIMITS,
  FLOW_RPC,
  type FlowAction,
  type FlowActions,
  type InterventionAction,
  type NodeStatus,
  type StageKind,
} from './flow';
import type { BatchCounts } from './batch';

export const SwarmWorkflowGateway = {
  Health: FLOW_RPC.health,
  List: FLOW_RPC.list,
  Control: FLOW_RPC.control,
  Detail: FLOW_RPC.detail,
  Intervene: FLOW_RPC.intervene,
  Batch: FLOW_RPC.batch,
  RetryBatch: FLOW_RPC.retryBatch,
} as const;
export type SwarmWorkflowAction = FlowAction;
export type SwarmWorkflowActions = FlowActions;
export const SWARM_WORKFLOW_INTERVENTION_LIMITS = {
  text: FLOW_LIMITS.interventionText,
  notes: FLOW_LIMITS.interventions,
} as const;
export type SwarmWorkflowInterventionAction = InterventionAction;
export interface SwarmWorkflowIntervention {
  id: string;
  action: SwarmWorkflowInterventionAction;
  text: string;
}
export interface SwarmWorkflowInterventionNote extends SwarmWorkflowIntervention {
  createdAt: number;
}
export function validSwarmWorkflowIntervention(value: unknown): value is SwarmWorkflowIntervention {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const note = value as SwarmWorkflowIntervention;
  return (
    typeof note.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(note.id) &&
    ['note', 'continue', 'retry'].includes(note.action) &&
    typeof note.text === 'string' &&
    note.text.length <= SWARM_WORKFLOW_INTERVENTION_LIMITS.text &&
    (note.action === 'retry' || Boolean(note.text.trim()))
  );
}
export type SwarmWorkflowNode = {
  id: string;
  title: string;
  deps: string[];
  kind: StageKind;
  status: NodeStatus;
  sessionKey: string;
  agentId?: string;
  agentName?: string;
  runId?: string;
  result?: string;
  error?: string;
  attempt?: number;
  batchCounts?: SwarmWorkflowBatchCounts;
};
export type SwarmWorkflowBatchCounts = BatchCounts;
export type SwarmWorkflowBatchItem = Pick<
  SwarmWorkflowNode,
  'id' | 'title' | 'status' | 'agentId' | 'agentName' | 'attempt' | 'error'
> & { startedAt?: number; endedAt?: number };
export type SwarmWorkflowBatchOptions = {
  status?: SwarmWorkflowNode['status'];
  search?: string;
  cursor?: string;
};
export type SwarmWorkflowBatchPage = {
  flowId: string;
  stageId: string;
  manifestVersion: string;
  revision: number;
  counts: SwarmWorkflowBatchCounts;
  matched: number;
  retryable: number;
  items: SwarmWorkflowBatchItem[];
  cursor?: string;
};
export function validBatchOptions(value: unknown): value is SwarmWorkflowBatchOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SwarmWorkflowBatchOptions;
  return (
    Object.keys(v).every(key => ['status', 'search', 'cursor'].includes(key)) &&
    (v.status === undefined ||
      ['queued', 'preparing', 'running', 'uncertain', 'done', 'failed', 'cancelled'].includes(
        v.status,
      )) &&
    (v.search === undefined || (typeof v.search === 'string' && v.search.length <= 100)) &&
    (v.cursor === undefined || (typeof v.cursor === 'string' && v.cursor.length <= 2048))
  );
}
export function validBatchPage(value: unknown): value is SwarmWorkflowBatchPage {
  if (!value || typeof value !== 'object') return false;
  const p = value as SwarmWorkflowBatchPage;
  return (
    typeof p.flowId === 'string' &&
    typeof p.stageId === 'string' &&
    typeof p.manifestVersion === 'string' &&
    Number.isSafeInteger(p.revision) &&
    p.revision > 0 &&
    Number.isSafeInteger(p.matched) &&
    p.matched >= 0 &&
    p.matched <= 1000 &&
    Number.isSafeInteger(p.retryable) &&
    p.retryable >= 0 &&
    p.retryable <= 1000 &&
    Boolean(p.counts) &&
    ['total', 'queued', 'preparing', 'running', 'uncertain', 'done', 'failed', 'cancelled'].every(
      key =>
        Number.isSafeInteger(p.counts[key as keyof SwarmWorkflowBatchCounts]) &&
        p.counts[key as keyof SwarmWorkflowBatchCounts] >= 0 &&
        p.counts[key as keyof SwarmWorkflowBatchCounts] <= 1000,
    ) &&
    Array.isArray(p.items) &&
    p.items.length <= 50 &&
    p.items.every(
      item =>
        item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        ['queued', 'preparing', 'running', 'uncertain', 'done', 'failed', 'cancelled'].includes(
          item.status,
        ),
    ) &&
    (p.cursor === undefined || (typeof p.cursor === 'string' && p.cursor.length <= 2048))
  );
}
export type SwarmWorkflowView = {
  canRetry?: boolean;
  actions?: SwarmWorkflowActions;
  id: string;
  revision: number;
  goal: string;
  createdAt: number;
  status: 'running' | 'paused' | 'blocked' | 'stopping' | 'cancelled' | 'completed';
  nodes: SwarmWorkflowNode[];
  error?: string;
};
export type SwarmWorkflowResult =
  { success: true; flows: SwarmWorkflowView[] } | { success: false };
export interface SwarmWorkflowDetail {
  flowId: string;
  nodeId: string;
  sessionKey: string;
  workingDirectory: string;
  status?: SwarmWorkflowNode['status'];
  error?: string;
  submission: 'not_sent' | 'uncertain' | 'submitted';
  dispatch?: { message: string; createdAt: number };
  revision?: number;
  interventions?: SwarmWorkflowInterventionNote[];
  canNote?: boolean;
  canContinue?: boolean;
  canRetry?: boolean;
}
export type SwarmWorkflowDetailResult =
  { success: true; detail: SwarmWorkflowDetail } | { success: false };
export function validFlowDetail(value: unknown): value is SwarmWorkflowDetail {
  if (!value || typeof value !== 'object') return false;
  const d = value as SwarmWorkflowDetail;
  return (
    typeof d.flowId === 'string' &&
    typeof d.nodeId === 'string' &&
    typeof d.sessionKey === 'string' &&
    typeof d.workingDirectory === 'string' &&
    (d.status === undefined ||
      ['queued', 'preparing', 'running', 'uncertain', 'done', 'failed', 'cancelled'].includes(
        d.status,
      )) &&
    (d.error === undefined || typeof d.error === 'string') &&
    ['not_sent', 'uncertain', 'submitted'].includes(d.submission) &&
    (d.revision === undefined || (Number.isSafeInteger(d.revision) && d.revision > 0)) &&
    [d.canNote, d.canContinue, d.canRetry].every(
      flag => flag === undefined || typeof flag === 'boolean',
    ) &&
    (d.interventions === undefined ||
      (Array.isArray(d.interventions) &&
        d.interventions.length <= SWARM_WORKFLOW_INTERVENTION_LIMITS.notes &&
        d.interventions.every(
          note => validSwarmWorkflowIntervention(note) && Number.isFinite(note.createdAt),
        ))) &&
    (d.dispatch === undefined ||
      // The flow engine bounds source fields; JSON escaping can expand them up to sixfold.
      // Do not impose a smaller independent limit on the serialized launch envelope.
      (typeof d.dispatch?.message === 'string' && Number.isFinite(d.dispatch.createdAt)))
  );
}
export function validFlowList(value: unknown): value is { flows: SwarmWorkflowView[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { flows?: unknown }).flows))
    return false;
  const flows = (value as { flows: unknown[] }).flows;
  return (
    flows.length <= 20 &&
    flows.every(item => {
      if (!item || typeof item !== 'object') return false;
      const f = item as SwarmWorkflowView;
      return (
        typeof f.id === 'string' &&
        Number.isSafeInteger(f.revision) &&
        f.revision > 0 &&
        (f.canRetry === undefined || typeof f.canRetry === 'boolean') &&
        (f.actions === undefined ||
          (f.actions !== null &&
            typeof f.actions === 'object' &&
            !Array.isArray(f.actions) &&
            ['pause', 'resume', 'stop', 'retry'].every(
              action => typeof f.actions?.[action as SwarmWorkflowAction] === 'boolean',
            ))) &&
        typeof f.goal === 'string' &&
        Number.isFinite(f.createdAt) &&
        ['running', 'paused', 'blocked', 'stopping', 'cancelled', 'completed'].includes(f.status) &&
        Array.isArray(f.nodes) &&
        f.nodes.length <= 11 &&
        f.nodes.every(
          n =>
            n &&
            typeof n.id === 'string' &&
            typeof n.title === 'string' &&
            typeof n.sessionKey === 'string' &&
            (n.agentId === undefined || typeof n.agentId === 'string') &&
            (n.agentName === undefined || typeof n.agentName === 'string') &&
            Array.isArray(n.deps) &&
            n.deps.every(d => typeof d === 'string') &&
            ['plan', 'work', 'batch', 'verify', 'deliver'].includes(n.kind) &&
            ['queued', 'preparing', 'running', 'uncertain', 'done', 'failed', 'cancelled'].includes(
              n.status,
            ) &&
            (n.result === undefined || typeof n.result === 'string') &&
            (n.error === undefined || typeof n.error === 'string'),
        )
      );
    })
  );
}
