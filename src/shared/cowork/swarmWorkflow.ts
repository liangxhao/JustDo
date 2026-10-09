export const SwarmWorkflowMode = { Auto: 'auto', Research: 'research', Review: 'review' } as const;
export type SwarmWorkflowOptions = {
  mode: (typeof SwarmWorkflowMode)[keyof typeof SwarmWorkflowMode];
  verify: boolean;
};
export type SwarmWorkflowPrepareResult =
  | { success: true; instruction: string }
  | { success: false; reason: 'disabled' | 'plan' | 'unavailable' | 'invalid' };
export const isSwarmWorkflowOptions = (value: unknown): value is SwarmWorkflowOptions => {
  if (!value || typeof value !== 'object') return false;
  const options = value as Record<string, unknown>;
  return (
    Object.values(SwarmWorkflowMode).includes(options.mode as SwarmWorkflowOptions['mode']) &&
    typeof options.verify === 'boolean' &&
    Object.keys(options).every(key => key === 'mode' || key === 'verify')
  );
};

export function buildSwarmWorkflowInstruction(options: SwarmWorkflowOptions): string {
  return `<justdo-swarm-workflow mode="${options.mode}"/>`;
}

// Match only the exact current workflow suffix; there are no historical aliases.
export function stripSwarmWorkflowInstruction(text: string): string {
  for (const mode of Object.values(SwarmWorkflowMode)) {
    const suffix = '\n\n' + buildSwarmWorkflowInstruction({ mode, verify: true });
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  }
  return text;
}

export const SwarmWorkflowIpc = {
  Prepare: 'cowork:swarm-workflow:prepare',
  List: 'cowork:swarm-workflow:list',
  Control: 'cowork:swarm-workflow:control',
  Detail: 'cowork:swarm-workflow:detail',
  Intervene: 'cowork:swarm-workflow:intervene',
  Batch: 'cowork:swarm-workflow:batch',
  RetryBatch: 'cowork:swarm-workflow:retry-batch',
} as const;
export const SwarmWorkflowGateway = {
  Health: 'swarmWorkflow.health',
  List: 'swarmWorkflow.list',
  Control: 'swarmWorkflow.control',
  Detail: 'swarmWorkflow.detail',
  Intervene: 'swarmWorkflow.intervene',
  Batch: 'swarmWorkflow.batch',
  RetryBatch: 'swarmWorkflow.retryBatch',
} as const;
export type SwarmWorkflowAction = 'pause' | 'resume' | 'stop' | 'retry';
export type SwarmWorkflowActions = Record<SwarmWorkflowAction, boolean>;
export const SWARM_WORKFLOW_INTERVENTION_LIMITS = { text: 4000, notes: 30 } as const;
export type SwarmWorkflowInterventionAction = 'note' | 'continue' | 'retry';
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
  kind: 'plan' | 'work' | 'batch' | 'verify' | 'deliver';
  status: 'queued' | 'preparing' | 'running' | 'uncertain' | 'done' | 'failed' | 'cancelled';
  sessionKey: string;
  agentId?: string;
  agentName?: string;
  runId?: string;
  result?: string;
  error?: string;
  attempt?: number;
  batchCounts?: SwarmWorkflowBatchCounts;
};
export type SwarmWorkflowBatchCounts = Record<SwarmWorkflowNode['status'], number> & {
  total: number;
};
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
  controlSwarmWorkflow(
    sessionId: string,
    id: string,
    revision: number,
    action: SwarmWorkflowAction,
  ): Promise<{ success: boolean }>;
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
