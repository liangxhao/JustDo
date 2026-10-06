export const SwarmFlowIpc = {
  List: 'cowork:swarm-flow:list',
  Control: 'cowork:swarm-flow:control',
  Detail: 'cowork:swarm-flow:detail',
  Intervene: 'cowork:swarm-flow:intervene',
  Batch: 'cowork:swarm-flow:batch',
  RetryBatch: 'cowork:swarm-flow:retry-batch',
} as const;
export const SwarmFlowGateway = {
  Health: 'swarmFlow.health',
  List: 'swarmFlow.list',
  Control: 'swarmFlow.control',
  Detail: 'swarmFlow.detail',
  Intervene: 'swarmFlow.intervene',
  Batch: 'swarmFlow.batch',
  RetryBatch: 'swarmFlow.retryBatch',
} as const;
export type SwarmFlowAction = 'pause' | 'resume' | 'stop' | 'retry';
export type SwarmFlowActions = Record<SwarmFlowAction, boolean>;
export const SWARM_INTERVENTION_LIMITS = { text: 4000, notes: 30 } as const;
export type SwarmInterventionAction = 'note' | 'continue' | 'retry';
export interface SwarmIntervention {
  id: string;
  action: SwarmInterventionAction;
  text: string;
}
export interface SwarmInterventionNote extends SwarmIntervention {
  createdAt: number;
}
export function validSwarmIntervention(value: unknown): value is SwarmIntervention {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const note = value as SwarmIntervention;
  return (
    typeof note.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(note.id) &&
    ['note', 'continue', 'retry'].includes(note.action) &&
    typeof note.text === 'string' &&
    note.text.length <= SWARM_INTERVENTION_LIMITS.text &&
    (note.action === 'retry' || Boolean(note.text.trim()))
  );
}
export type SwarmFlowNode = {
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
  batchCounts?: SwarmBatchCounts;
};
export type SwarmBatchCounts = Record<SwarmFlowNode['status'], number> & { total: number };
export type SwarmBatchItem = Pick<
  SwarmFlowNode,
  'id' | 'title' | 'status' | 'agentId' | 'agentName' | 'attempt' | 'error'
> & { startedAt?: number; endedAt?: number };
export type SwarmBatchOptions = {
  status?: SwarmFlowNode['status'];
  search?: string;
  cursor?: string;
};
export type SwarmBatchPage = {
  flowId: string;
  stageId: string;
  manifestVersion: string;
  revision: number;
  counts: SwarmBatchCounts;
  matched: number;
  retryable: number;
  items: SwarmBatchItem[];
  cursor?: string;
};
export function validBatchOptions(value: unknown): value is SwarmBatchOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SwarmBatchOptions;
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
export function validBatchPage(value: unknown): value is SwarmBatchPage {
  if (!value || typeof value !== 'object') return false;
  const p = value as SwarmBatchPage;
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
        Number.isSafeInteger(p.counts[key as keyof SwarmBatchCounts]) &&
        p.counts[key as keyof SwarmBatchCounts] >= 0 &&
        p.counts[key as keyof SwarmBatchCounts] <= 1000,
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
export type SwarmFlowView = {
  canRetry?: boolean;
  actions?: SwarmFlowActions;
  id: string;
  revision: number;
  goal: string;
  createdAt: number;
  status: 'running' | 'paused' | 'blocked' | 'stopping' | 'cancelled' | 'completed';
  nodes: SwarmFlowNode[];
  error?: string;
};
export type SwarmFlowResult = { success: true; flows: SwarmFlowView[] } | { success: false };
export interface SwarmFlowDetail {
  flowId: string;
  nodeId: string;
  sessionKey: string;
  workingDirectory: string;
  status?: SwarmFlowNode['status'];
  error?: string;
  submission: 'not_sent' | 'uncertain' | 'submitted';
  dispatch?: { message: string; createdAt: number };
  revision?: number;
  interventions?: SwarmInterventionNote[];
  canNote?: boolean;
  canContinue?: boolean;
  canRetry?: boolean;
}
export type SwarmFlowDetailResult = { success: true; detail: SwarmFlowDetail } | { success: false };
export function validFlowDetail(value: unknown): value is SwarmFlowDetail {
  if (!value || typeof value !== 'object') return false;
  const d = value as SwarmFlowDetail;
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
        d.interventions.length <= SWARM_INTERVENTION_LIMITS.notes &&
        d.interventions.every(
          note => validSwarmIntervention(note) && Number.isFinite(note.createdAt),
        ))) &&
    (d.dispatch === undefined ||
      // The flow engine bounds source fields; JSON escaping can expand them up to sixfold.
      // Do not impose a smaller independent limit on the serialized launch envelope.
      (typeof d.dispatch?.message === 'string' && Number.isFinite(d.dispatch.createdAt)))
  );
}
export interface SwarmFlowApi {
  getSwarmBatch(
    sessionId: string,
    flowId: string,
    stageId: string,
    options: SwarmBatchOptions,
  ): Promise<{ success: true; page: SwarmBatchPage } | { success: false }>;
  retrySwarmBatch(
    sessionId: string,
    flowId: string,
    stageId: string,
    revision: number,
    operationId: string,
    itemIds?: string[],
  ): Promise<{ success: boolean; retried?: number; skipped?: number; reasons?: string[] }>;
  interveneSwarmFlow(
    sessionId: string,
    flowId: string,
    nodeId: string,
    revision: number,
    intervention: SwarmIntervention,
  ): Promise<{ success: boolean }>;
  getSwarmFlowDetail(
    sessionId: string,
    flowId: string,
    nodeId: string,
    sourceId?: string,
  ): Promise<SwarmFlowDetailResult>;
  getSwarmFlows(sessionId: string): Promise<SwarmFlowResult>;
  controlSwarmFlow(
    sessionId: string,
    id: string,
    revision: number,
    action: SwarmFlowAction,
  ): Promise<{ success: boolean }>;
}
export function validFlowList(value: unknown): value is { flows: SwarmFlowView[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { flows?: unknown }).flows))
    return false;
  const flows = (value as { flows: unknown[] }).flows;
  return (
    flows.length <= 20 &&
    flows.every(item => {
      if (!item || typeof item !== 'object') return false;
      const f = item as SwarmFlowView;
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
              action => typeof f.actions?.[action as SwarmFlowAction] === 'boolean',
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
