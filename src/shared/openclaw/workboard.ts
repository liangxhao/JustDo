export const WORKBOARD_STATUSES = [
  'triage',
  'backlog',
  'todo',
  'scheduled',
  'ready',
  'running',
  'review',
  'blocked',
  'done',
] as const;

export const WORKBOARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const WORKBOARD_CHANGED_EVENT = 'plugin.workboard.changed' as const;
export const WORKBOARD_BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];

export type WorkboardComment = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
};

export type WorkboardEvent = {
  id: string;
  kind: string;
  at: number;
  fromStatus?: WorkboardStatus;
  toStatus?: WorkboardStatus;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardRunAttempt = {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'stopped';
  startedAt: number;
  endedAt?: number;
  engine?: string;
  mode?: 'autonomous' | 'manual';
  model?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

export type WorkboardLink = {
  id: string;
  type: string;
  createdAt: number;
  targetCardId?: string;
  title?: string;
  url?: string;
};

export type WorkboardProof = {
  id: string;
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardArtifact = {
  id: string;
  createdAt: number;
  label?: string;
  url?: string;
  path?: string;
  mimeType?: string;
};

export type WorkboardAttachment = {
  id: string;
  cardId: string;
  createdAt: number;
  fileName: string;
  byteSize: number;
  mimeType?: string;
  note?: string;
};

export type WorkboardWorkerLog = {
  id: string;
  createdAt: number;
  level: 'info' | 'warning' | 'error';
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardDiagnostic = {
  kind: string;
  severity: string;
  title: string;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  actions: Array<{
    kind: 'claim' | 'unblock' | 'promote' | 'reclaim' | 'reassign' | 'add_proof' | 'open_session';
    label: string;
  }>;
};

export type WorkboardNotification = {
  id: string;
  kind: string;
  createdAt: number;
  sequence?: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkerProtocol = {
  state: 'idle' | 'running' | 'completed' | 'blocked' | 'violated';
  detail?: string;
  updatedAt: number;
};

export type WorkboardWorkspace = {
  kind: 'scratch' | 'dir' | 'worktree';
  path?: string;
  branch?: string;
  sourcePath?: string;
  sourceBranch?: string;
};

export type WorkboardLaunchState = {
  requestedSessionKey: string;
  provisionalRunId: string;
  preparedAt: number;
  phase: 'prepared' | 'accepted' | 'failed';
  acceptedAt?: number;
  acceptedSessionKey?: string;
  acceptedRunId?: string;
  failedAt?: number;
  reason?: string;
};

export type WorkboardAutomation = {
  tenant?: string;
  boardId?: string;
  createdByCardId?: string;
  idempotencyKey?: string;
  skills?: string[];
  workspace?: WorkboardWorkspace;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  scheduledAt?: number;
  summary?: string;
  createdCardIds?: string[];
  dispatchCount?: number;
  lastDispatchAt?: number;
  launch?: WorkboardLaunchState;
};

export type WorkboardClaim = {
  ownerId: string;
  token: string;
  claimedAt: number;
  lastHeartbeatAt: number;
  expiresAt?: number;
};

export type WorkboardMetadata = {
  attempts?: WorkboardRunAttempt[];
  automation?: WorkboardAutomation;
  comments?: WorkboardComment[];
  links?: WorkboardLink[];
  proof?: WorkboardProof[];
  artifacts?: WorkboardArtifact[];
  attachments?: WorkboardAttachment[];
  workerLogs?: WorkboardWorkerLog[];
  workerProtocol?: WorkboardWorkerProtocol;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: string;
  archivedAt?: number;
  stale?: {
    detectedAt: number;
    lastSessionUpdatedAt?: number;
    reason: string;
  };
  lifecycleStatusSourceUpdatedAt?: number;
  failureCount?: number;
};

export type WorkboardExecution = {
  id: string;
  kind: 'agent-session';
  engine?: string;
  mode: 'autonomous' | 'manual';
  status: 'idle' | 'running' | 'review' | 'blocked' | 'done';
  model?: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  metadata?: WorkboardMetadata;
  events?: WorkboardEvent[];
};

export type WorkboardBoardSummary = {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  automationJobId?: string;
  defaultWorkspace?: WorkboardWorkspace;
  orchestration?: {
    autoDecompose?: boolean;
    autoDecomposePerDispatch?: number;
    defaultAssignee?: string;
    orchestratorProfile?: string;
  };
  total: number;
  active: number;
  archived: number;
  byStatus: Partial<Record<WorkboardStatus, number>>;
  updatedAt?: number;
  archivedAt?: number;
};

export type WorkboardCardInput = {
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  boardId?: string;
};

export type WorkboardCardPatch = Partial<Omit<WorkboardCardInput, 'boardId'>>;

export type WorkboardSnapshot = {
  cards: WorkboardCard[];
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
};

export type WorkboardDispatchSummary = {
  started: number;
  failures: number;
  promoted: number;
  blocked: number;
  reclaimed: number;
  orchestrated: number;
};

export type WorkboardStartResult = {
  card: WorkboardCard;
  sessionKey: string;
  runId?: string;
};

export type WorkboardSessionResolution = {
  sessionKey: string;
};

export type WorkboardStopIdentity = {
  sessionKey?: string;
  runId?: string;
  taskId?: string;
};

export type WorkboardResult<T = undefined> = {
  success: boolean;
  data?: T;
  error?: string;
};

export type WorkboardChangedEvent = {
  epoch?: string;
  revision?: number;
};

export const WorkboardIpc = {
  GetSnapshot: 'openclaw:workboard:getSnapshot',
  CreateCard: 'openclaw:workboard:createCard',
  UpdateCard: 'openclaw:workboard:updateCard',
  MoveCard: 'openclaw:workboard:moveCard',
  DeleteCard: 'openclaw:workboard:deleteCard',
  ArchiveCard: 'openclaw:workboard:archiveCard',
  CommentCard: 'openclaw:workboard:commentCard',
  StartCard: 'openclaw:workboard:startCard',
  StopCard: 'openclaw:workboard:stopCard',
  ResolveSession: 'openclaw:workboard:resolveSession',
  Dispatch: 'openclaw:workboard:dispatch',
  Changed: 'openclaw:workboard:changed',
} as const;

export const workboardCardBoardId = (card: WorkboardCard): string =>
  card.metadata?.automation?.boardId?.trim() || 'default';

export const workboardCardSessionKey = (card: WorkboardCard): string | undefined =>
  card.sessionKey?.trim() || card.execution?.sessionKey?.trim() || undefined;

export const canStartWorkboardCard = (card: WorkboardCard, now = Date.now()): boolean => {
  const claimExpiresAt = card.metadata?.claim?.expiresAt;
  const hasActiveClaim = typeof claimExpiresAt === 'number' && claimExpiresAt > now;
  return (
    !card.metadata?.archivedAt &&
    (card.status === 'backlog' || card.status === 'todo' || card.status === 'ready') &&
    !workboardCardSessionKey(card) &&
    !card.taskId?.trim() &&
    !hasActiveClaim
  );
};

export const workboardCardHasLiveExecution = (card: WorkboardCard): boolean => {
  return card.status === 'running' || card.execution?.status === 'running';
};

export const isWorkboardStatus = (value: unknown): value is WorkboardStatus =>
  typeof value === 'string' && WORKBOARD_STATUSES.some(status => status === value);

export const isWorkboardPriority = (value: unknown): value is WorkboardPriority =>
  typeof value === 'string' && WORKBOARD_PRIORITIES.some(priority => priority === value);

export const isValidWorkboardBoardId = (value: unknown): value is string =>
  typeof value === 'string' && WORKBOARD_BOARD_ID_PATTERN.test(value);
