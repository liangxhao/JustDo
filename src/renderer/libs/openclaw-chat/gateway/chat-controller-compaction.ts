import { isDefinitiveSessionGoalGatewayError } from '@shared/cowork/sessionGoal';
import { isBenignCompactionNoopReason } from '@shared/openclaw/compaction';

import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/chunked-message-history';
import { i18nService } from '@/services/i18n';

import type { ChatController } from './chat-controller';
import {
  ChatState,
  ChatStreamUpdateKind,
  CompactionCheckpoint,
  formatI18n,
  isCompactionMarker,
  isLocalCompactionStatus,
  LocalCompactionStatus,
  MANUAL_COMPACTION_STOP_RETRY_WINDOW_MS,
  readCompactionMarkerFingerprint,
  readNonBlankString,
  SessionLiveState,
} from './chat-controller-support';
export interface ChatControllerCompactionContext {
  readonly isSelectedSession: (sessionKey: string) => boolean;
  readonly state: ChatState;
  readonly findLiveSessionState: (
    sessionKey: string | null | undefined,
    sessionId?: string | null,
  ) => [string, SessionLiveState] | null;
  readonly chatMessagesBySession: Map<string, ChunkedMessageHistory>;
  readonly setCurrentSessionMessages: (
    messages: unknown[],
    options?: { resetLoadedHistory?: boolean },
  ) => void;
  readonly localCompactionStatusBySession: Map<string, LocalCompactionStatus>;
  readonly deferredHistoryReloadAttempts: Map<string, number>;
  readonly updateLocalCompactionMessage: (
    sessionKey: string,
    statusId: string,
    replacement: unknown | null,
  ) => void;
  transcriptIdSequence: number;
  readonly settledCompactionEventIds: Set<string>;
  readonly beginLocalCompactionStatus: (
    sessionKey: string,
    options?: { forceNew?: boolean; eventId?: string },
  ) => LocalCompactionStatus;
  readonly updateLocalCompactionSummary: (
    sessionKey: string,
    status: LocalCompactionStatus,
    data: Record<string, unknown>,
  ) => void;
  readonly clearLifecycleEndFallback: () => void;
  readonly notifyStream: (kind?: ChatStreamUpdateKind) => void;
  readonly notify: () => void;
  readonly completeLocalCompactionStatus: (
    sessionKey: string,
    tokens?: { before?: number; after?: number },
  ) => LocalCompactionStatus | null;
  readonly projectLocalCompactionStatus: (sessionKey: string, messages: unknown[]) => unknown[];
  readonly terminalLifecycleSeen: boolean;
  readonly scheduleChatLifecycleEndFallback: () => void;
  readonly scheduleDeferredHistoryReload: (sessionKey: string, reason: string) => void;
  readonly manualCompactionOperations: Map<
    string,
    {
      sessionKey: string;
      client: NonNullable<ChatController['state']['client']>;
      cancelled: boolean;
      settled: boolean;
      error?: unknown;
    }
  >;
  readonly settleCompactionRequest: (sessionKey: string, errorMessage?: string) => void;
  readonly manualCompactionRequestIdsBySession: Map<string, string>;
  readonly loadHistory: (
    queueIfBusy?: boolean,
    options?: {
      preferStartup?: boolean;
      reconcileSuspended?: boolean;
      backfillActiveSessionsYield?: boolean;
    },
  ) => Promise<boolean>;
  readonly loadCompactionCheckpoints: (sessionKey?: string) => Promise<CompactionCheckpoint[]>;
}

export function settleCompactionRequest(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  errorMessage?: string,
): void {
  if (this.isSelectedSession(sessionKey)) {
    this.state.chatSending = false;
    this.state.compactionInFlight = false;
    if (errorMessage) this.state.lastError = errorMessage;
    return;
  }
  const cached = this.findLiveSessionState(sessionKey)?.[1];
  if (!cached) return;
  cached.chatSending = false;
  cached.compactionInFlight = false;
  if (errorMessage) cached.lastError = errorMessage;
}

export function updateLocalCompactionMessage(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  statusId: string,
  replacement: unknown | null,
): void {
  const history =
    this.state.sessionKey === sessionKey
      ? this.state.chatMessages
      : this.chatMessagesBySession.get(sessionKey)?.recentMessages;
  if (!history) return;
  const nextMessages = history.flatMap(message =>
    isLocalCompactionStatus(message, statusId)
      ? replacement === null
        ? []
        : [replacement]
      : [message],
  );
  if (this.state.sessionKey === sessionKey) {
    this.setCurrentSessionMessages(nextMessages);
    return;
  }
  this.chatMessagesBySession.get(sessionKey)?.replaceRecent(nextMessages);
}

export function projectLocalCompactionStatus(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  messages: unknown[],
): unknown[] {
  const status = this.localCompactionStatusBySession.get(sessionKey);
  if (!status) return messages;
  const hasAuthoritativeMarker = messages.some(message => {
    const fingerprint = readCompactionMarkerFingerprint(message);
    if (fingerprint === null || status.markerFingerprintsBefore.has(fingerprint)) return false;
    // The transcript entry id and compaction item id are distinct. A delayed
    // marker from the preceding operation must not replace the current status.
    if (status.eventId?.startsWith('item:')) {
      const marker = (message as Record<string, unknown>).__openclaw as Record<string, unknown>;
      return marker.itemId === status.eventId.slice('item:'.length);
    }
    return true;
  });
  if (hasAuthoritativeMarker) status.authoritativeMarkerSeen = true;
  const phase = status.message.__openclaw.phase;
  if (status.authoritativeMarkerSeen && (phase === 'in-progress' || phase === 'completed')) {
    // A transcript commit precedes the native terminal event. Hide the local
    // card, but retain its identity until that event can settle the operation.
    if (phase === 'completed') this.localCompactionStatusBySession.delete(sessionKey);
    this.deferredHistoryReloadAttempts.delete(sessionKey);
    return messages.filter(message => !isLocalCompactionStatus(message, status.id));
  }
  return [
    ...messages.filter(message => !isLocalCompactionStatus(message, status.id)),
    status.message,
  ];
}

export function beginLocalCompactionStatus(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  options: { forceNew?: boolean; eventId?: string } = {},
): LocalCompactionStatus {
  const existing = this.localCompactionStatusBySession.get(sessionKey);
  const sameOperation =
    (options.eventId && options.eventId === existing?.eventId) ||
    ((!options.eventId || !existing?.eventId) &&
      existing?.message.__openclaw.phase === 'in-progress');
  if (existing && sameOperation && !options.forceNew) {
    existing.eventId ??= options.eventId;
    return existing;
  }
  if (existing) {
    this.updateLocalCompactionMessage(sessionKey, existing.id, null);
  }
  const startedAt = Date.now();
  const id = `local-compaction-${startedAt}-${this.transcriptIdSequence++}`;
  const status: LocalCompactionStatus = {
    id,
    eventId: options.eventId,
    markerFingerprintsBefore: new Set(
      (this.isSelectedSession(sessionKey)
        ? this.state.chatMessages
        : (this.chatMessagesBySession.get(sessionKey)?.recentMessages ?? [])
      )
        .map(readCompactionMarkerFingerprint)
        .filter((fingerprint): fingerprint is string => fingerprint !== null),
    ),
    message: {
      role: 'system',
      timestamp: startedAt,
      __openclaw: {
        kind: 'compaction-status',
        id,
        phase: 'in-progress',
      },
    },
  };
  this.deferredHistoryReloadAttempts.delete(sessionKey);
  this.localCompactionStatusBySession.set(sessionKey, status);
  if (this.state.sessionKey === sessionKey) {
    this.setCurrentSessionMessages([...this.state.chatMessages, status.message]);
  } else {
    const history = this.chatMessagesBySession.get(sessionKey) ?? new ChunkedMessageHistory();
    history.replaceRecent([...history.recentMessages, status.message]);
    this.chatMessagesBySession.set(sessionKey, history);
  }
  return status;
}

export function completeLocalCompactionStatus(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  tokens?: { before?: number; after?: number },
): LocalCompactionStatus | null {
  const status = this.localCompactionStatusBySession.get(sessionKey);
  if (!status) return null;
  status.message = {
    ...status.message,
    __openclaw: {
      ...status.message.__openclaw,
      phase: 'completed',
      tokensBefore: tokens?.before ?? status.message.__openclaw.tokensBefore,
      tokensAfter: tokens?.after ?? status.message.__openclaw.tokensAfter,
    },
  };
  this.updateLocalCompactionMessage(sessionKey, status.id, status.message);
  return status;
}

export function updateLocalCompactionSummary(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  status: LocalCompactionStatus,
  data: Record<string, unknown>,
): void {
  const currentSummary = status.message.__openclaw.summary ?? '';
  const accumulated =
    typeof data.text === 'string'
      ? data.text
      : typeof data.summary === 'string'
        ? data.summary
        : undefined;
  const delta = typeof data.delta === 'string' ? data.delta : '';
  const summary = accumulated ?? `${currentSummary}${delta}`;
  if (!summary || summary === currentSummary) return;
  status.message = {
    ...status.message,
    __openclaw: {
      ...status.message.__openclaw,
      summary,
    },
  };
  this.updateLocalCompactionMessage(sessionKey, status.id, status.message);
}

export function clearLocalCompactionStatus(
  this: ChatControllerCompactionContext,
  sessionKey: string,
): void {
  const status = this.localCompactionStatusBySession.get(sessionKey);
  if (!status) return;
  this.localCompactionStatusBySession.delete(sessionKey);
  this.deferredHistoryReloadAttempts.delete(sessionKey);
  this.updateLocalCompactionMessage(sessionKey, status.id, null);
}

export function handleCompactionPhase(
  this: ChatControllerCompactionContext,
  phase: string,
  sessionKey = this.state.sessionKey,
  data: Record<string, unknown> = {},
): void {
  const isCurrentSession = this.isSelectedSession(sessionKey);
  const eventId =
    typeof data.operationId === 'string'
      ? `operation:${data.operationId}`
      : typeof data.itemId === 'string'
        ? `item:${data.itemId}`
        : undefined;
  const settledKey = eventId ? JSON.stringify([sessionKey, eventId]) : undefined;
  if (settledKey && this.settledCompactionEventIds.has(settledKey)) return;
  const existing = this.localCompactionStatusBySession.get(sessionKey);
  // A late terminal/update from the preceding compaction must not settle its successor.
  if (phase !== 'start' && eventId && existing?.eventId && existing.eventId !== eventId) {
    return;
  }
  if (phase === 'start' || phase === 'update') {
    const status = this.beginLocalCompactionStatus(sessionKey, { eventId });
    if (status.message.__openclaw.phase !== 'in-progress') return;
    this.updateLocalCompactionSummary(sessionKey, status, data);
    if (!isCurrentSession) {
      const cached = this.findLiveSessionState(sessionKey)?.[1];
      if (cached) cached.compactionInFlight = true;
      return;
    }
    this.state.compactionInFlight = true;
    this.clearLifecycleEndFallback();
    this.notifyStream();
    this.notify();
    return;
  }
  if (phase !== 'end' && phase !== 'error' && phase !== 'failed') return;
  if (settledKey) {
    this.settledCompactionEventIds.add(settledKey);
    if (this.settledCompactionEventIds.size > 256) {
      this.settledCompactionEventIds.delete(this.settledCompactionEventIds.values().next().value!);
    }
  }
  const unsuccessful =
    phase !== 'end' ||
    data.completed === false ||
    data.outcome === 'failed' ||
    data.outcome === 'skipped' ||
    data.outcome === 'aborted';
  const wasInProgress =
    this.localCompactionStatusBySession.get(sessionKey)?.message.__openclaw.phase === 'in-progress';
  const inProgressStatus = this.localCompactionStatusBySession.get(sessionKey);
  if (inProgressStatus) this.updateLocalCompactionSummary(sessionKey, inProgressStatus, data);
  const status = unsuccessful
    ? inProgressStatus
    : this.completeLocalCompactionStatus(sessionKey, {
        before: typeof data.tokensBefore === 'number' ? data.tokensBefore : undefined,
        after: typeof data.tokensAfter === 'number' ? data.tokensAfter : undefined,
      });
  if (unsuccessful && status) {
    status.message = {
      ...status.message,
      __openclaw: {
        ...status.message.__openclaw,
        phase: data.outcome === 'skipped' || data.outcome === 'aborted' ? data.outcome : 'failed',
        reason: readNonBlankString(data.reason) ?? readNonBlankString(data.error),
      },
    };
    this.updateLocalCompactionMessage(sessionKey, status.id, status.message);
    this.deferredHistoryReloadAttempts.delete(sessionKey);
  }
  if (status?.authoritativeMarkerSeen) {
    if (unsuccessful) {
      // An extension can fail after the transcript commit. Preserve both the
      // committed marker and the terminal diagnostic in that case.
      const messages = isCurrentSession
        ? this.state.chatMessages
        : (this.chatMessagesBySession.get(sessionKey)?.recentMessages ?? []);
      const projected = this.projectLocalCompactionStatus(sessionKey, messages);
      if (isCurrentSession) this.setCurrentSessionMessages(projected);
      else this.chatMessagesBySession.get(sessionKey)?.replaceRecent(projected);
    } else {
      this.localCompactionStatusBySession.delete(sessionKey);
      this.deferredHistoryReloadAttempts.delete(sessionKey);
    }
  }
  if (!isCurrentSession) {
    const cached = this.findLiveSessionState(sessionKey)?.[1];
    if (cached) cached.compactionInFlight = false;
    return;
  }
  this.state.compactionInFlight = false;
  if (this.terminalLifecycleSeen) this.scheduleChatLifecycleEndFallback();
  if (status && wasInProgress && !unsuccessful && !status.authoritativeMarkerSeen) {
    this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
  }
  this.notifyStream();
  this.notify();
}

export async function cancelManualCompaction(
  this: ChatControllerCompactionContext,
  sessionKey: string,
): Promise<void> {
  const operations = [...this.manualCompactionOperations.values()].filter(
    operation => operation.sessionKey === sessionKey,
  );
  for (const operation of operations) operation.cancelled = true;
  // The native cancellation handle is registered after async preparation.
  // A no-active-run reply during that preparation is not completion proof.
  const needsConfirmation = (operation: (typeof operations)[number]) =>
    !operation.settled ||
    Boolean(operation.error && !isDefinitiveSessionGoalGatewayError(operation.error));
  const retryDeadline = Date.now() + MANUAL_COMPACTION_STOP_RETRY_WINDOW_MS;
  while (operations.some(needsConfirmation)) {
    // Preparation may never register a native handle. Keep its admission
    // uncertain, but release the Stop control so the user can retry instead
    // of polling forever behind a disabled button. Each RPC is also bounded
    // by the Gateway client's transport timeout.
    if (Date.now() >= retryDeadline) throw new Error(i18nService.t('coworkStopFailed'));
    const operation = operations.find(needsConfirmation)!;
    const client = this.state.connected && this.state.client ? this.state.client : operation.client;
    const result = await client.request<{ ok?: boolean; status?: string }>('sessions.abort', {
      key: sessionKey,
      clearQueued: true,
    });
    if (result.ok !== true || !['aborted', 'no-active-run'].includes(result.status ?? '')) {
      throw new Error('Gateway did not confirm compaction cancellation');
    }
    if (
      operation.settled &&
      operation.error &&
      !isDefinitiveSessionGoalGatewayError(operation.error)
    ) {
      if (result.status !== 'aborted') throw operation.error;
      operation.error = undefined;
    }
    if (operations.some(candidate => !candidate.settled)) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const uncertain = operations.find(
    operation => operation.error && !isDefinitiveSessionGoalGatewayError(operation.error),
  );
  if (uncertain) throw uncertain.error;
  for (const [id, operation] of this.manualCompactionOperations) {
    if (operations.includes(operation)) this.manualCompactionOperations.delete(id);
  }
  if (operations.length > 0) {
    this.settleCompactionRequest(sessionKey);
    if (this.isSelectedSession(sessionKey)) {
      this.notifyStream();
      this.notify();
    }
  }
}

export async function compactSession(
  this: ChatControllerCompactionContext,
  _argumentsText = '',
): Promise<void> {
  const client = this.state.client;
  if (!client || !this.state.connected) throw new Error('not connected');
  const sessionKey = this.state.sessionKey;
  if (
    [...this.manualCompactionOperations.values()].some(
      operation =>
        operation.sessionKey === sessionKey &&
        operation.cancelled &&
        (!operation.settled || operation.error),
    )
  ) {
    throw new Error('The session is still stopping');
  }
  // v2026.9.2 sessions.compact accepts key, agentId and maxLines only.
  // Inline instructions cannot be forwarded by this RPC.
  const localStatus = this.beginLocalCompactionStatus(sessionKey, { forceNew: true });
  const statusId = localStatus.id;
  const markerFingerprintsBefore = localStatus.markerFingerprintsBefore;
  const operation = {
    sessionKey,
    client,
    cancelled: false,
    settled: false,
    error: undefined as unknown,
  };
  this.manualCompactionOperations.set(statusId, operation);
  this.manualCompactionRequestIdsBySession.set(sessionKey, statusId);
  const requestStillCurrent = (): boolean =>
    this.state.client === client &&
    this.manualCompactionRequestIdsBySession.get(sessionKey) === statusId;

  this.state.chatSending = true;
  this.state.compactionInFlight = true;
  this.state.lastError = null;
  this.notifyStream();
  this.notify();

  try {
    const result = await client.request<{
      ok?: boolean;
      compacted?: boolean;
      reason?: string;
      result?: { tokensBefore?: number; tokensAfter?: number };
    }>('sessions.compact', { key: sessionKey });
    operation.settled = true;
    if (!requestStillCurrent()) return;
    if (operation.cancelled) {
      this.updateLocalCompactionMessage(sessionKey, statusId, {
        ...localStatus.message,
        __openclaw: { ...localStatus.message.__openclaw, phase: 'aborted' },
      });
      this.localCompactionStatusBySession.delete(sessionKey);
      this.settleCompactionRequest(sessionKey);
      if (this.isSelectedSession(sessionKey)) {
        this.notifyStream();
        this.notify();
      }
      return;
    }
    if (result?.ok === false && !isBenignCompactionNoopReason(result.reason)) {
      throw new Error(result.reason || i18nService.t('coworkCompactUnknownError'));
    }
    const before = result?.result?.tokensBefore;
    const after = result?.result?.tokensAfter;
    if (result?.compacted) {
      this.completeLocalCompactionStatus(sessionKey, { before, after });
      this.settleCompactionRequest(sessionKey);
      if (!this.isSelectedSession(sessionKey)) return;
      this.notifyStream();
      this.notify();
      const historyLoaded = await this.loadHistory();
      if (!requestStillCurrent() || !this.isSelectedSession(sessionKey)) return;
      if (!historyLoaded) {
        // A history read failure cannot undo the acknowledged compaction.
        // Keep its success visible while waiting for the durable marker.
        this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
        return;
      }
      let newMarkerIndex = -1;
      for (let index = this.state.chatMessages.length - 1; index >= 0; index--) {
        const message = this.state.chatMessages[index];
        if (!isCompactionMarker(message)) continue;
        const fingerprint = readCompactionMarkerFingerprint(message);
        if (fingerprint && !markerFingerprintsBefore.has(fingerprint)) {
          newMarkerIndex = index;
          break;
        }
      }
      if (newMarkerIndex < 0) {
        return;
      }
      this.setCurrentSessionMessages(
        this.state.chatMessages.map((message, index) => {
          if (index !== newMarkerIndex) return message;
          const record = message as Record<string, unknown>;
          const marker = record.__openclaw as Record<string, unknown>;
          return {
            ...record,
            __openclaw: {
              ...marker,
              tokensBefore: marker.tokensBefore ?? before,
              tokensAfter: marker.tokensAfter ?? after,
            },
          };
        }),
      );
      this.notify();
      return;
    }
    this.localCompactionStatusBySession.delete(sessionKey);
    this.deferredHistoryReloadAttempts.delete(sessionKey);
    const skippedMessage = {
      role: 'system',
      timestamp: localStatus.message.timestamp,
      __openclaw: {
        kind: 'compaction-skipped',
        reason: result?.reason,
      },
    };
    this.updateLocalCompactionMessage(sessionKey, statusId, skippedMessage);
    this.settleCompactionRequest(sessionKey);
    if (!this.isSelectedSession(sessionKey)) return;
    this.notifyStream();
    this.notify();
  } catch (err) {
    operation.error = err;
    operation.settled = true;
    if (!requestStillCurrent()) return;
    if (operation.cancelled && !isDefinitiveSessionGoalGatewayError(err)) {
      if (this.isSelectedSession(sessionKey)) {
        this.state.lastError = (err as Error).message;
        this.notify();
      }
      return;
    }
    this.localCompactionStatusBySession.delete(sessionKey);
    this.deferredHistoryReloadAttempts.delete(sessionKey);
    const errorMessage = (err as Error).message;
    this.updateLocalCompactionMessage(sessionKey, statusId, {
      role: 'system',
      content: formatI18n('coworkCompactFailed', { error: errorMessage }),
      timestamp: localStatus.message.timestamp,
    });
    this.settleCompactionRequest(sessionKey, errorMessage);
    if (!this.isSelectedSession(sessionKey)) return;
    this.notifyStream();
    this.notify();
  } finally {
    operation.settled = true;
    // Retain an uncertain cancelled request so a retry cannot silently claim
    // success after its transport has disappeared during native preparation.
    if (
      !operation.cancelled ||
      !operation.error ||
      isDefinitiveSessionGoalGatewayError(operation.error)
    ) {
      this.manualCompactionOperations.delete(statusId);
    }
    if (this.manualCompactionRequestIdsBySession.get(sessionKey) === statusId) {
      this.manualCompactionRequestIdsBySession.delete(sessionKey);
    }
  }
}

export async function loadCompactionCheckpoints(
  this: ChatControllerCompactionContext,
  sessionKey = this.state.sessionKey,
): Promise<CompactionCheckpoint[]> {
  const client = this.state.client;
  if (!client) return [];
  try {
    const response = await client.request<{
      checkpoints?: CompactionCheckpoint[];
    }>('sessions.compaction.list', { key: sessionKey });
    return response?.checkpoints ?? [];
  } catch (err) {
    console.warn('[ChatController] Failed to load compaction checkpoints', (err as Error).message);
    return [];
  }
}

export async function enrichCompactionMarkers(
  this: ChatControllerCompactionContext,
  messages: unknown[],
  sessionKey = this.state.sessionKey,
): Promise<unknown[]> {
  const markerIndexes = messages.flatMap((message, index) =>
    isCompactionMarker(message) ? [index] : [],
  );
  if (markerIndexes.length === 0) return messages;

  const checkpoints = await this.loadCompactionCheckpoints(sessionKey);
  if (checkpoints.length === 0) return messages;
  const checkpointsByTranscriptId = new Map<string, CompactionCheckpoint>();
  const checkpointsById = new Map<string, CompactionCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.checkpointId) checkpointsById.set(checkpoint.checkpointId, checkpoint);
    for (const id of [checkpoint.postCompaction?.entryId, checkpoint.postCompaction?.leafId]) {
      if (id) checkpointsByTranscriptId.set(id, checkpoint);
    }
  }
  const checkpointsNewestFirst = [...checkpoints].sort(
    (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
  );
  const checkpointByMarkerIndex = new Map<number, (typeof checkpoints)[number]>();
  const assignedCheckpointIds = new Set<string>();

  for (const markerIndex of markerIndexes) {
    const marker = (messages[markerIndex] as Record<string, unknown>).__openclaw as Record<
      string,
      unknown
    >;
    const markerId = typeof marker.id === 'string' ? marker.id : undefined;
    const exactCheckpoint = markerId
      ? (checkpointsByTranscriptId.get(markerId) ?? checkpointsById.get(markerId))
      : undefined;
    if (!exactCheckpoint) continue;
    checkpointByMarkerIndex.set(markerIndex, exactCheckpoint);
    if (exactCheckpoint.checkpointId) assignedCheckpointIds.add(exactCheckpoint.checkpointId);
  }

  // OpenClaw transcript markers carry the compaction-entry id, while the
  // checkpoint API exposes a separately generated checkpoint UUID. Align the
  // remaining records newest-to-newest so each historical marker receives at
  // most one checkpoint instead of reusing the latest checkpoint for all of them.
  const unmatchedMarkerIndexesNewestFirst = markerIndexes
    .filter(markerIndex => !checkpointByMarkerIndex.has(markerIndex))
    .reverse();
  const unassignedCheckpointsNewestFirst = checkpointsNewestFirst.filter(checkpoint => {
    const hasTranscriptPosition = Boolean(
      checkpoint.postCompaction?.entryId || checkpoint.postCompaction?.leafId,
    );
    return (
      !hasTranscriptPosition &&
      (!checkpoint.checkpointId || !assignedCheckpointIds.has(checkpoint.checkpointId))
    );
  });
  for (
    let index = 0;
    index <
    Math.min(unmatchedMarkerIndexesNewestFirst.length, unassignedCheckpointsNewestFirst.length);
    index++
  ) {
    checkpointByMarkerIndex.set(
      unmatchedMarkerIndexesNewestFirst[index],
      unassignedCheckpointsNewestFirst[index],
    );
  }

  return messages.map((message, index) => {
    if (!isCompactionMarker(message)) return message;
    const record = message as Record<string, unknown>;
    const marker = record.__openclaw as Record<string, unknown>;
    const checkpoint = checkpointByMarkerIndex.get(index);
    if (!checkpoint) return message;
    return {
      ...record,
      __openclaw: {
        ...marker,
        checkpointId: checkpoint.checkpointId,
        summary: readNonBlankString(checkpoint.summary) ?? readNonBlankString(marker.summary),
        tokensBefore: checkpoint.tokensBefore ?? marker.tokensBefore,
        tokensAfter: checkpoint.tokensAfter ?? marker.tokensAfter,
      },
    };
  });
}
