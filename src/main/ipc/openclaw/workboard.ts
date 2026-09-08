import { ipcMain } from 'electron';

import {
  isValidWorkboardBoardId,
  isWorkboardPriority,
  isWorkboardStatus,
  WORKBOARD_STATUSES,
  type WorkboardBoardSummary,
  type WorkboardCard,
  workboardCardHasLiveExecution,
  type WorkboardCardInput,
  type WorkboardCardPatch,
  type WorkboardDispatchSummary,
  WorkboardIpc,
  type WorkboardResult,
  type WorkboardSessionResolution,
  type WorkboardSnapshot,
  type WorkboardStartResult,
} from '../../../shared/openclaw/workboard';
import type { OpenClawRuntimeAdapter } from '../../engine';

type WorkboardHandlerDependencies = {
  getRuntime: () => OpenClawRuntimeAdapter | null;
};

type GatewayCardResult = { card?: WorkboardCard };
type GatewayListResult = { cards?: WorkboardCard[]; statuses?: unknown };
type GatewayBoardsResult = { boards?: WorkboardBoardSummary[] };
type GatewayAgentsResult = {
  defaultId?: unknown;
  agents?: Array<{ id?: unknown }>;
};
type GatewayDispatchResult = Record<string, unknown>;
type GatewayStartResult = {
  card?: WorkboardCard;
  sessionKey?: string;
  runId?: string;
};
type GatewaySessionRow = {
  key?: unknown;
  hasActiveRun?: unknown;
};
type GatewaySessionsResult = {
  sessions?: GatewaySessionRow[];
  hasMore?: boolean;
  totalCount?: number;
};

type GatewayTaskCancelResult = {
  cancelled?: boolean;
  found?: boolean;
  task?: { status?: unknown };
};

type GatewayChatAbortResult = {
  aborted?: boolean;
  runIds?: unknown;
};

const WORKBOARD_CARD_TITLE_MAX_LENGTH = 180;
const WORKBOARD_CARD_NOTES_MAX_LENGTH = 4_000;
const WORKBOARD_CARD_LABEL_MAX_LENGTH = 40;

const normalizeId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
};

const normalizeLabels = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > 12) return null;
  const labels = value.map(label => (typeof label === 'string' ? label.trim() : ''));
  if (labels.some(label => !label || label.length > WORKBOARD_CARD_LABEL_MAX_LENGTH)) return null;
  return [...new Set(labels)];
};

const normalizeOptionalString = (value: unknown, maxLength: number): string | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : null;
};

export const normalizeWorkboardCardInput = (value: unknown): WorkboardCardInput | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const title = normalizeOptionalString(source.title, WORKBOARD_CARD_TITLE_MAX_LENGTH);
  const notes = normalizeOptionalString(source.notes, WORKBOARD_CARD_NOTES_MAX_LENGTH);
  const agentId = normalizeOptionalString(source.agentId, 256);
  const sessionKey = normalizeOptionalString(source.sessionKey, 240);
  const boardId = normalizeOptionalString(source.boardId, 80);
  const labels = normalizeLabels(source.labels);
  if (
    !title ||
    notes === null ||
    agentId === null ||
    sessionKey === null ||
    boardId === null ||
    (boardId !== undefined && boardId !== '' && !isValidWorkboardBoardId(boardId)) ||
    labels === null ||
    !isWorkboardStatus(source.status) ||
    !isWorkboardPriority(source.priority)
  ) {
    return null;
  }
  return {
    title,
    notes,
    status: source.status,
    priority: source.priority,
    labels,
    agentId,
    sessionKey,
    boardId,
  };
};

export const normalizeWorkboardCardPatch = (value: unknown): WorkboardCardPatch | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const allowed = new Set([
    'title',
    'notes',
    'status',
    'priority',
    'labels',
    'agentId',
    'sessionKey',
  ]);
  if (Object.keys(source).length === 0 || Object.keys(source).some(key => !allowed.has(key))) {
    return null;
  }
  const patch: WorkboardCardPatch = {};
  if ('title' in source) {
    const title = normalizeOptionalString(source.title, WORKBOARD_CARD_TITLE_MAX_LENGTH);
    if (!title) return null;
    patch.title = title;
  }
  if ('notes' in source) {
    const notes = normalizeOptionalString(source.notes, WORKBOARD_CARD_NOTES_MAX_LENGTH);
    if (notes === null) return null;
    patch.notes = notes;
  }
  if ('agentId' in source) {
    const agentId = normalizeOptionalString(source.agentId, 256);
    if (agentId === null) return null;
    patch.agentId = agentId;
  }
  if ('sessionKey' in source) {
    const sessionKey = normalizeOptionalString(source.sessionKey, 240);
    if (sessionKey === null) return null;
    patch.sessionKey = sessionKey;
  }
  if ('status' in source) {
    if (!isWorkboardStatus(source.status)) return null;
    patch.status = source.status;
  }
  if ('priority' in source) {
    if (!isWorkboardPriority(source.priority)) return null;
    patch.priority = source.priority;
  }
  if ('labels' in source) {
    const labels = normalizeLabels(source.labels);
    if (!labels) return null;
    patch.labels = labels;
  }
  return patch;
};

const dispatchSummary = (value: GatewayDispatchResult): WorkboardDispatchSummary => {
  const count = (key: string): number => (Array.isArray(value[key]) ? value[key].length : 0);
  return {
    started: count('started'),
    failures: count('startFailures'),
    promoted: count('promoted'),
    blocked: count('blocked'),
    reclaimed: count('reclaimed'),
    orchestrated: count('orchestrated'),
  };
};

const chatRunWasAborted = (value: GatewayChatAbortResult): boolean =>
  value.aborted === true || (Array.isArray(value.runIds) && value.runIds.length > 0);

const gatewayTaskIsKnownInactive = (value: GatewayTaskCancelResult): boolean => {
  if (value.found === false) return true;
  if (value.found !== true || typeof value.task?.status !== 'string') return false;
  return ['completed', 'failed', 'cancelled', 'timed_out'].includes(value.task.status);
};

const defaultAgentIdFromGateway = (value: GatewayAgentsResult): string | null => {
  const defaultId = normalizeId(value.defaultId);
  if (defaultId) return defaultId;
  const agentIds = (value.agents ?? [])
    .map(agent => normalizeId(agent.id))
    .filter((id): id is string => Boolean(id));
  return agentIds.find(id => id === 'main') ?? agentIds[0] ?? null;
};

export const registerOpenClawWorkboardHandlers = ({
  getRuntime,
}: WorkboardHandlerDependencies): void => {
  const request = async <T>(method: string, params: unknown = {}): Promise<T> => {
    const client = getRuntime()?.getGatewayClient();
    if (!client) throw new Error('Gateway client not connected');
    return client.request<T>(method, params);
  };
  const run = async <T>(operation: () => Promise<T>): Promise<WorkboardResult<T>> => {
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Workboard operation failed',
      };
    }
  };
  const assignDefaultAgent = async (card: WorkboardCard): Promise<WorkboardCard> => {
    if (card.agentId?.trim()) return card;
    const agentId = defaultAgentIdFromGateway(await request<GatewayAgentsResult>('agents.list'));
    if (!agentId) {
      throw new Error('No default execution agent is available for this Workboard card');
    }
    const result = await request<GatewayCardResult>('workboard.cards.update', {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { agentId },
    });
    if (!result.card) throw new Error('Gateway returned no assigned Workboard card');
    return result.card;
  };
  const prepareDefaultAgentAssignments = async (boardId?: string): Promise<void> => {
    const listed = await request<GatewayListResult>('workboard.cards.list');
    const candidates = (listed.cards ?? []).filter(card => {
      const candidateBoardId = card.metadata?.automation?.boardId?.trim() || 'default';
      return (
        !card.agentId?.trim() &&
        !card.metadata?.archivedAt &&
        (card.status === 'backlog' || card.status === 'todo' || card.status === 'ready') &&
        (!boardId || candidateBoardId === boardId)
      );
    });
    if (candidates.length === 0) return;
    const agentId = defaultAgentIdFromGateway(await request<GatewayAgentsResult>('agents.list'));
    if (!agentId) {
      throw new Error('No default execution agent is available for Workboard dispatch');
    }
    for (const card of candidates) {
      await request<GatewayCardResult>('workboard.cards.update', {
        id: card.id,
        expectedUpdatedAt: card.updatedAt,
        patch: { agentId },
      });
    }
  };
  const resolveSession = async (
    rawSessionKey: unknown,
  ): Promise<{ sessionKey: string; hasActiveRun?: boolean }> => {
    const sessionKey = normalizeOptionalString(rawSessionKey, 240);
    if (!sessionKey) throw new Error('Invalid Workboard session key');
    const normalized = sessionKey.toLowerCase();
    if (normalized === 'global' || normalized === 'unknown') {
      throw new Error('Workboard session link is ambiguous');
    }
    const result = await request<GatewaySessionsResult>('sessions.list', {
      search: sessionKey,
      archived: 'all',
      limit: 20,
      configuredAgentsOnly: false,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: false,
      includeLastMessage: false,
    });
    const candidates = (result.sessions ?? []).filter(row => {
      const candidate = typeof row.key === 'string' ? row.key.trim().toLowerCase() : '';
      return candidate === normalized || candidate.endsWith(`:${normalized}`);
    });
    const resolved = (row: GatewaySessionRow) => {
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      return {
        sessionKey: key,
        ...(typeof row.hasActiveRun === 'boolean' ? { hasActiveRun: row.hasActiveRun } : {}),
      };
    };
    const exact = candidates.find(row => {
      const candidate = typeof row.key === 'string' ? row.key.trim().toLowerCase() : '';
      return candidate === normalized;
    });
    if (exact) return resolved(exact);
    const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidates.length > 1) throw new Error('Workboard session link is ambiguous');
    if (result.hasMore === true || (result.totalCount ?? 0) > (result.sessions?.length ?? 0)) {
      throw new Error('Workboard session could not be resolved from the current session page');
    }
    if (onlyCandidate) return resolved(onlyCandidate);
    throw new Error('Linked Workboard session is unavailable');
  };
  const resolveSessionKey = async (rawSessionKey: unknown): Promise<string> => {
    return (await resolveSession(rawSessionKey)).sessionKey;
  };

  ipcMain.handle(WorkboardIpc.GetSnapshot, () =>
    run<WorkboardSnapshot>(async () => {
      const [cardResult, boardResult] = await Promise.all([
        request<GatewayListResult>('workboard.cards.list'),
        request<GatewayBoardsResult>('workboard.boards.list'),
      ]);
      const statuses = Array.isArray(cardResult.statuses)
        ? cardResult.statuses.filter(isWorkboardStatus)
        : [];
      return {
        cards: Array.isArray(cardResult.cards) ? cardResult.cards : [],
        boards: Array.isArray(boardResult.boards) ? boardResult.boards : [],
        statuses: statuses.length > 0 ? statuses : WORKBOARD_STATUSES,
      };
    }),
  );

  ipcMain.handle(WorkboardIpc.CreateCard, (_event, value: unknown) =>
    run<WorkboardCard>(async () => {
      const input = normalizeWorkboardCardInput(value);
      if (!input) throw new Error('Invalid Workboard card input');
      const result = await request<GatewayCardResult>('workboard.cards.create', input);
      if (!result.card) throw new Error('Gateway returned no Workboard card');
      return result.card;
    }),
  );

  ipcMain.handle(
    WorkboardIpc.UpdateCard,
    (_event, rawId: unknown, rawPatch: unknown, rawExpectedUpdatedAt: unknown) =>
      run<WorkboardCard>(async () => {
        const id = normalizeId(rawId);
        const patch = normalizeWorkboardCardPatch(rawPatch);
        if (
          !id ||
          !patch ||
          typeof rawExpectedUpdatedAt !== 'number' ||
          !Number.isFinite(rawExpectedUpdatedAt)
        ) {
          throw new Error('Invalid Workboard card update');
        }
        const result = await request<GatewayCardResult>('workboard.cards.update', {
          id,
          patch,
          expectedUpdatedAt: rawExpectedUpdatedAt,
        });
        if (!result.card) throw new Error('Gateway returned no Workboard card');
        return result.card;
      }),
  );

  ipcMain.handle(
    WorkboardIpc.MoveCard,
    (_event, rawId: unknown, rawStatus: unknown, rawPosition: unknown) =>
      run<WorkboardCard>(async () => {
        const id = normalizeId(rawId);
        if (
          !id ||
          !isWorkboardStatus(rawStatus) ||
          typeof rawPosition !== 'number' ||
          !Number.isFinite(rawPosition)
        ) {
          throw new Error('Invalid Workboard card move');
        }
        const result = await request<GatewayCardResult>('workboard.cards.move', {
          id,
          status: rawStatus,
          position: rawPosition,
        });
        if (!result.card) throw new Error('Gateway returned no Workboard card');
        return result.card;
      }),
  );

  ipcMain.handle(WorkboardIpc.DeleteCard, (_event, rawId: unknown) =>
    run(async () => {
      const id = normalizeId(rawId);
      if (!id) throw new Error('Invalid Workboard card id');
      await request('workboard.cards.delete', { id });
    }),
  );

  ipcMain.handle(WorkboardIpc.ArchiveCard, (_event, rawId: unknown, rawArchived: unknown) =>
    run<WorkboardCard>(async () => {
      const id = normalizeId(rawId);
      if (!id || typeof rawArchived !== 'boolean') {
        throw new Error('Invalid Workboard archive request');
      }
      const result = await request<GatewayCardResult>('workboard.cards.archive', {
        id,
        archived: rawArchived,
      });
      if (!result.card) throw new Error('Gateway returned no Workboard card');
      return result.card;
    }),
  );

  ipcMain.handle(WorkboardIpc.CommentCard, (_event, rawId: unknown, rawBody: unknown) =>
    run<WorkboardCard>(async () => {
      const id = normalizeId(rawId);
      const body = normalizeOptionalString(rawBody, 2_000);
      if (!id || !body) throw new Error('Invalid Workboard comment');
      const result = await request<GatewayCardResult>('workboard.cards.comment', { id, body });
      if (!result.card) throw new Error('Gateway returned no Workboard card');
      return result.card;
    }),
  );

  ipcMain.handle(WorkboardIpc.StartCard, (_event, rawId: unknown) =>
    run<WorkboardStartResult>(async () => {
      const id = normalizeId(rawId);
      if (!id) throw new Error('Invalid Workboard card id');
      const listed = await request<GatewayListResult>('workboard.cards.list');
      const currentCard = listed.cards?.find(card => card.id === id);
      if (!currentCard) throw new Error('Workboard card is unavailable');
      await assignDefaultAgent(currentCard);
      const result = await request<GatewayStartResult>('workboard.cards.start', { id });
      const sessionKey = normalizeOptionalString(result.sessionKey, 240);
      if (!result.card || !sessionKey) {
        throw new Error('Gateway returned no started Workboard execution');
      }
      return {
        card: result.card,
        sessionKey,
        ...(typeof result.runId === 'string' && result.runId.trim()
          ? { runId: result.runId.trim() }
          : {}),
      };
    }),
  );

  ipcMain.handle(WorkboardIpc.StopCard, (_event, rawId: unknown, rawExpectedExecution: unknown) =>
    run<WorkboardCard>(async () => {
      const id = normalizeId(rawId);
      if (!id) throw new Error('Invalid Workboard card id');
      const listed = await request<GatewayListResult>('workboard.cards.list');
      const card = listed.cards?.find(candidate => candidate.id === id);
      if (!card) throw new Error('Workboard card is unavailable');

      // A stale drawer can outlive completion; do not rewrite the completed card.
      if (!workboardCardHasLiveExecution(card)) return card;

      const linkedSessionKey = card.sessionKey?.trim() || card.execution?.sessionKey?.trim();
      const runId = card.runId?.trim() || card.execution?.runId?.trim();
      const taskId = card.taskId?.trim();
      if (rawExpectedExecution !== undefined) {
        if (
          !rawExpectedExecution ||
          typeof rawExpectedExecution !== 'object' ||
          Array.isArray(rawExpectedExecution)
        ) {
          throw new Error('Invalid Workboard execution identity');
        }
        const expected = rawExpectedExecution as Record<string, unknown>;
        const expectedSessionKey = normalizeOptionalString(expected.sessionKey, 240);
        const expectedRunId = normalizeOptionalString(expected.runId, 256);
        const expectedTaskId = normalizeOptionalString(expected.taskId, 256);
        if (
          expectedSessionKey === null ||
          expectedRunId === null ||
          expectedTaskId === null ||
          (!expectedSessionKey && !expectedTaskId)
        ) {
          throw new Error('Invalid Workboard execution identity');
        }
        if (
          (expectedRunId || undefined) !== (runId || undefined) ||
          (expectedTaskId || undefined) !== (taskId || undefined) ||
          Boolean(expectedSessionKey) !== Boolean(linkedSessionKey) ||
          (linkedSessionKey &&
            expectedSessionKey &&
            linkedSessionKey.toLowerCase() !== expectedSessionKey.toLowerCase() &&
            (await resolveSessionKey(linkedSessionKey)).toLowerCase() !==
              expectedSessionKey.toLowerCase())
        ) {
          throw new Error('Workboard execution changed; refresh its session before stopping');
        }
      }
      let taskStopped = false;
      let taskAlreadyInactive = !taskId;
      if (taskId) {
        const cancelled = await request<GatewayTaskCancelResult>('tasks.cancel', {
          taskId,
          reason: 'Stopped from Workboard.',
        });
        taskStopped = cancelled.cancelled === true;
        taskAlreadyInactive = gatewayTaskIsKnownInactive(cancelled);
      }
      let sessionAborted = false;
      let sessionAlreadyInactive = !linkedSessionKey;
      if (linkedSessionKey) {
        const session = await resolveSession(linkedSessionKey);
        sessionAlreadyInactive = session.hasActiveRun === false;
        if (!sessionAlreadyInactive) {
          const targeted = await request<GatewayChatAbortResult>('chat.abort', {
            sessionKey: session.sessionKey,
            ...(runId ? { runId } : {}),
          });
          sessionAborted = chatRunWasAborted(targeted);
          if (!sessionAborted && runId) {
            sessionAborted = chatRunWasAborted(
              await request<GatewayChatAbortResult>('chat.abort', {
                sessionKey: session.sessionKey,
              }),
            );
          }
          if (!sessionAborted) {
            sessionAlreadyInactive =
              (await resolveSession(session.sessionKey)).hasActiveRun === false;
          }
        }
      }
      if (!linkedSessionKey && !card.taskId) {
        throw new Error('Workboard card has no live execution to stop');
      }
      if (!(taskStopped || taskAlreadyInactive) || !(sessionAborted || sessionAlreadyInactive)) {
        throw new Error('Gateway did not stop the linked Workboard execution');
      }

      const execution = card.execution
        ? { ...card.execution, status: 'blocked' as const, updatedAt: Date.now() }
        : undefined;
      const updated = await request<GatewayCardResult>('workboard.cards.update', {
        id,
        expectedUpdatedAt: card.updatedAt,
        patch: {
          status: 'blocked',
          ...(execution ? { execution } : {}),
        },
      });
      if (!updated.card) throw new Error('Gateway returned no stopped Workboard card');
      return updated.card;
    }),
  );

  ipcMain.handle(WorkboardIpc.ResolveSession, (_event, rawSessionKey: unknown) =>
    run<WorkboardSessionResolution>(async () => {
      return { sessionKey: await resolveSessionKey(rawSessionKey) };
    }),
  );

  ipcMain.handle(WorkboardIpc.Dispatch, (_event, rawBoardId: unknown) =>
    run<WorkboardDispatchSummary>(async () => {
      const boardId = normalizeOptionalString(rawBoardId, 80);
      if (
        boardId === null ||
        (boardId !== undefined && boardId !== '' && !isValidWorkboardBoardId(boardId))
      ) {
        throw new Error('Invalid Workboard board id');
      }
      await prepareDefaultAgentAssignments(boardId || undefined);
      const result = await request<GatewayDispatchResult>(
        'workboard.cards.dispatch',
        boardId ? { boardId } : {},
      );
      return dispatchSummary(result);
    }),
  );
};
