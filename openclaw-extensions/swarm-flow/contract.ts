import type {
  BatchCounts,
  BatchItemIdentity,
  BatchPlan,
  ItemResultManifest,
} from './batch-contract.js';
import type { SwarmSettings } from './settings.js';

export const FLOW_RPC = {
  start: 'swarmFlow.start',
  list: 'swarmFlow.list',
  control: 'swarmFlow.control',
  health: 'swarmFlow.health',
  detail: 'swarmFlow.detail',
  intervene: 'swarmFlow.intervene',
  batch: 'swarmFlow.batch',
  retryBatch: 'swarmFlow.retryBatch',
} as const;
export type FlowStatus = 'running' | 'paused' | 'blocked' | 'stopping' | 'cancelled' | 'completed';
export type NodeStatus =
  'queued' | 'preparing' | 'running' | 'uncertain' | 'done' | 'failed' | 'cancelled';
export type FlowAction = 'pause' | 'resume' | 'stop' | 'retry';
export type FlowActions = Record<FlowAction, boolean>;
export type InterventionAction = 'note' | 'continue' | 'retry';
export type FlowIntervention = {
  id: string;
  action: InterventionAction;
  text: string;
  createdAt: number;
};
export const FLOW_TOOLS = {
  complete: 'swarm_flow_complete',
  verify: 'swarm_flow_verify',
  block: 'swarm_flow_block',
} as const;
export const FLOW_MANAGEMENT_TOOLS = {
  status: 'swarm_flow_status',
  control: 'swarm_flow_control',
  intervene: 'swarm_flow_intervene',
  batch: 'swarm_flow_batch',
  retryBatch: 'swarm_flow_retry_batch',
} as const;
export type FlowOperation = { id: string; action: FlowAction };
export type FlowNotice = { id: string; state: 'sending' | 'sent' | 'unconfirmed' };
export type FlowSubmission = {
  outcome: 'complete' | 'verified' | 'blocked';
  summary: string;
  evidence: string[];
  passed?: boolean;
};
export type FlowReceipt = FlowSubmission & { runId: string; createdAt: number };
export type FlowAttempt = {
  attempt: number;
  sessionKey: string;
  runId?: string;
  status: NodeStatus;
  error?: string;
  endedAt?: number;
  receipt?: FlowReceipt;
  submissionRuns?: Array<{ runId: string; endedAt: number }>;
};
export type StageKind = 'plan' | 'work' | 'batch' | 'verify' | 'deliver';
export const DEFAULT_FLOW_AGENT = 'main';
export interface FlowAgent {
  id: string;
  name: string;
}
export interface FlowNode {
  id: string;
  title: string;
  task: string;
  deps: string[];
  kind: StageKind;
  access: 'read' | 'write';
  status: NodeStatus;
  sessionKey: string;
  agentId: string;
  agentName: string;
  completionMode?: 'tool';
  completion?: FlowReceipt;
  planningRepair?: { passes: number; error: string };
  submissionRepair?: {
    runId: string;
    passes: number;
    instruction: string;
    priorRuns: Array<{ runId: string; endedAt: number }>;
    pending?: boolean;
  };
  attempt?: number;
  attempts?: FlowAttempt[];
  interventions?: FlowIntervention[];
  continuation?: boolean;
  runId?: string;
  intendedRunId?: string;
  dispatch?: { message: string; createdAt: number };
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  batch?: BatchPlan;
  batchInput?: { version: string; manifestPath: string };
  batchCounts?: BatchCounts;
  batchItem?: BatchItemIdentity;
  artifacts?: ItemResultManifest;
  deadlineAt?: number;
  cleanupSettled?: boolean;
  budgetExceeded?: boolean;
}
export interface Flow {
  id: string;
  requestId: string;
  parentKey: string;
  parentId: string;
  agentId: string;
  agents: FlowAgent[];
  cwd: string;
  permissionMode: string;
  policy?: string;
  mode: string;
  goal: string;
  assignmentRequest?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  status: FlowStatus;
  nodes: FlowNode[];
  error?: string;
  delivered?: boolean;
  deliveryIntent?: boolean;
  operations?: FlowOperation[];
  notices?: FlowNotice[];
  settings?: SwarmSettings;
  concurrency?: number;
  controlVersion?: number;
  filesystemAdmission?: {
    workspaceOnly: boolean;
    root: string;
    policy: string;
    dev: string;
    ino: string;
    agentIds: string[];
  };
  batchOperations?: Array<{
    id: string;
    fingerprint: string;
    retried: string[];
    skipped: string[];
    reasons: Record<string, string>;
  }>;
}
export type FlowView = Pick<
  Flow,
  'id' | 'revision' | 'createdAt' | 'updatedAt' | 'status' | 'goal' | 'mode' | 'error' | 'delivered'
> & {
  canRetry: boolean;
  actions: FlowActions;
  nodes: Array<
    Omit<
      FlowNode,
      | 'task'
      | 'intendedRunId'
      | 'dispatch'
      | 'completionMode'
      | 'completion'
      | 'submissionRepair'
      | 'planningRepair'
      | 'attempts'
      | 'interventions'
      | 'continuation'
    >
  >;
};
/** Shared by the chat tools and Tab; delivery uncertainty still allows stopping the flow. */
export function flowActions(flow: Flow): FlowActions {
  const ended = ['completed', 'cancelled', 'stopping'].includes(flow.status);
  const delivering = flow.status === 'running' && Boolean(flow.deliveryIntent) && !flow.delivered;
  return {
    pause: !ended && !delivering && flow.status === 'running',
    resume:
      !ended &&
      flow.status === 'paused' &&
      !flow.nodes.some(
        node =>
          node.kind !== 'batch' && !node.batchItem && ['failed', 'uncertain'].includes(node.status),
      ),
    stop: !ended && !delivering,
    retry:
      flow.status === 'blocked' &&
      !flow.error &&
      !flow.deliveryIntent &&
      !flow.nodes.some(node => node.kind === 'batch' && (node.batchCounts?.failed ?? 0) > 0) &&
      flow.nodes.some(node => node.status === 'failed') &&
      !flow.nodes.some(node => ['running', 'preparing', 'uncertain'].includes(node.status)) &&
      flow.nodes
        .filter(node => node.status === 'failed')
        .every(node => (node.attempt ?? 1) < (flow.settings?.maxAttempts ?? FLOW_LIMITS.attempts)),
  };
}
export function viewFlow(flow: Flow): FlowView {
  const { id, revision, createdAt, updatedAt, status, goal, mode, error, delivered } = flow;
  const actions = flowActions(flow);
  return {
    id,
    revision,
    createdAt,
    updatedAt,
    status,
    goal,
    mode,
    error,
    delivered,
    canRetry: actions.retry,
    actions,
    nodes: flow.nodes
      .filter(node => !node.batchItem)
      .map(
        ({
          task: _task,
          intendedRunId: _intent,
          dispatch: _dispatch,
          completionMode: _mode,
          completion: _completion,
          submissionRepair: _repair,
          planningRepair: _planningRepair,
          attempts: _attempts,
          interventions: _interventions,
          continuation: _continuation,
          batch: _batch,
          batchInput: _batchInput,
          artifacts: _artifacts,
          ...node
        }) => node,
      ),
  };
}
export const FLOW_LIMITS = {
  nodes: 8,
  parallel: 3,
  result: 24000,
  goal: 16000,
  attempts: 3,
  submissionRepairs: 3,
  planningRepairs: 3,
  interventions: 30,
  interventionText: 4000,
  operations: 512,
  notices: 64,
  durationMs: 3600000,
} as const;
