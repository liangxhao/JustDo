export const FLOW_RPC = {
  start: 'swarmFlow.start',
  list: 'swarmFlow.list',
  control: 'swarmFlow.control',
  health: 'swarmFlow.health',
  detail: 'swarmFlow.detail',
  intervene: 'swarmFlow.intervene',
} as const;
export type FlowStatus = 'running' | 'paused' | 'blocked' | 'stopping' | 'cancelled' | 'completed';
export type NodeStatus =
  'queued' | 'preparing' | 'running' | 'uncertain' | 'done' | 'failed' | 'cancelled';
export type FlowAction = 'pause' | 'resume' | 'stop' | 'retry';
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
export type StageKind = 'plan' | 'work' | 'verify' | 'deliver';
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
}
export type FlowView = Pick<
  Flow,
  'id' | 'revision' | 'createdAt' | 'updatedAt' | 'status' | 'goal' | 'mode' | 'error' | 'delivered'
> & {
  canRetry: boolean;
  nodes: Array<
    Omit<
      FlowNode,
      | 'task'
      | 'intendedRunId'
      | 'dispatch'
      | 'completionMode'
      | 'completion'
      | 'submissionRepair'
      | 'attempts'
      | 'interventions'
      | 'continuation'
    >
  >;
};
export function viewFlow(flow: Flow): FlowView {
  const { id, revision, createdAt, updatedAt, status, goal, mode, error, delivered } = flow;
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
    canRetry:
      status === 'blocked' &&
      !error &&
      !flow.deliveryIntent &&
      flow.nodes.some(node => node.status === 'failed') &&
      !flow.nodes.some(node => ['running', 'preparing', 'uncertain'].includes(node.status)) &&
      flow.nodes
        .filter(node => node.status === 'failed')
        .every(node => (node.attempt ?? 1) < FLOW_LIMITS.attempts),
    nodes: flow.nodes.map(
      ({
        task: _task,
        intendedRunId: _intent,
        dispatch: _dispatch,
        completionMode: _mode,
        completion: _completion,
        submissionRepair: _repair,
        attempts: _attempts,
        interventions: _interventions,
        continuation: _continuation,
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
  interventions: 30,
  interventionText: 4000,
  durationMs: 3600000,
} as const;
