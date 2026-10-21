import { isDefinitiveSessionGoalGatewayError } from '@shared/cowork/sessionGoal';
import { isBenignCompactionNoopReason, isCompactionAbortReason } from '@shared/openclaw/compaction';

import { ChunkedMessageHistory } from '@/libs/openclaw-chat/model/history/chunked-message-history';
import {
  compactionEventId,
  findTurnCompaction,
  matchesCompactionHistory,
  setCompactionMessage,
} from '@/libs/openclaw-chat/model/turn/compaction-item';
import { hydrateGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import type { ChatController } from '../chat-controller';
import {
  ChatState,
  ChatStreamUpdateKind,
  formatI18n,
  isLocalCompactionStatus,
  LocalCompactionStatus,
  MANUAL_COMPACTION_STOP_RETRY_WINDOW_MS,
  readCompactionMarkerFingerprint,
  readNonBlankString,
  SessionLiveState,
} from '../chat-controller-support';

export interface ManualCompactionOperation {
  sessionKey: string;
  operationId: string;
  client: NonNullable<ChatController['state']['client']>;
  cancelled: boolean;
  settled: boolean;
  nativeSettled: boolean;
  status: LocalCompactionStatus;
  error?: unknown;
}

interface CompactionOperationSnapshot {
  operationId: string;
  key: string;
  phase: 'in-progress' | 'settled' | 'unknown';
  outcome?: 'completed' | 'skipped' | 'failed' | 'aborted';
  compacted?: boolean;
  markerExpected?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  reason?: string;
}

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
  readonly manualCompactionOperations: Map<string, ManualCompactionOperation>;
  readonly manualCompactionRecoveryGeneration: number;
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
  if (replacement) {
    const transcript = this.isSelectedSession(sessionKey)
      ? this.state.transcript
      : this.findLiveSessionState(sessionKey)?.[1].transcript;
    const item = transcript?.activeTurn?.items.find(
      item => item.type === 'compaction' && item.message?.__openclaw?.id === statusId,
    );
    if (item?.type === 'compaction') {
      setCompactionMessage(item, replacement as GatewayMessage);
      transcript!.revision += 1;
    }
  }
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
  applyCompactionHistory.call(this, sessionKey, messages);
  const status = this.localCompactionStatusBySession.get(sessionKey);
  if (!status) return messages;
  const hasAuthoritativeMarker = messages.some(message => {
    if (status.markerExpected === false) return false;
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
  const transcript = this.isSelectedSession(sessionKey)
    ? this.state.transcript
    : this.findLiveSessionState(sessionKey)?.[1].transcript;
  const item = findTurnCompaction(transcript?.activeTurn ?? null, options.eventId);
  if (item) {
    setCompactionMessage(item, status.message);
    transcript!.revision += 1;
  }
  if (this.state.sessionKey === sessionKey) {
    this.setCurrentSessionMessages([...this.state.chatMessages, status.message]);
  } else {
    const history = this.chatMessagesBySession.get(sessionKey) ?? new ChunkedMessageHistory();
    history.replaceRecent([...history.recentMessages, status.message]);
    this.chatMessagesBySession.set(sessionKey, history);
  }
  return status;
}

/** Enrich the admitted live position without replacing the running transcript. */
function applyCompactionHistory(
  this: ChatControllerCompactionContext,
  sessionKey: string,
  messages: unknown[],
): boolean {
  const transcript = this.isSelectedSession(sessionKey)
    ? this.state.transcript
    : this.findLiveSessionState(sessionKey)?.[1].transcript;
  let matched = false;
  for (const message of messages) {
    for (const item of transcript?.activeTurn?.items ?? []) {
      if (item.type !== 'compaction' || !item.message || !matchesCompactionHistory(item, message))
        continue;
      matched = true;
      const marker = (message as GatewayMessage).__openclaw!;
      item.historyEntryId = marker.id as string;
      const metadata = { ...item.message.__openclaw };
      if (typeof marker.summary === 'string' && marker.summary.trim())
        metadata.summary = marker.summary;
      for (const field of ['tokensBefore', 'tokensAfter'] as const) {
        if (
          typeof marker[field] === 'number' &&
          Number.isFinite(marker[field]) &&
          marker[field] >= 0
        )
          metadata[field] = marker[field];
      }
      setCompactionMessage(item, { ...item.message, __openclaw: metadata });
      const status = this.localCompactionStatusBySession.get(sessionKey);
      if (status && status.id === metadata.id) {
        status.message = item.message as LocalCompactionStatus['message'];
        this.updateLocalCompactionMessage(sessionKey, status.id, status.message);
      }
      transcript!.revision += 1;
    }
  }
  return matched;
}

export function observeCompactionHistoryMessage(
  this: ChatControllerCompactionContext,
  message: unknown,
): boolean {
  const { sessionKey, client, transcript, currentSessionId } = this.state;
  const turn = transcript.activeTurn;
  if (!turn || !applyCompactionHistory.call(this, sessionKey, [message])) return false;
  this.notifyStream();
  this.notify();
  const generation = transcript.historyGeneration;
  const isCurrent = () =>
    this.state.connected &&
    this.state.client === client &&
    this.state.sessionKey === sessionKey &&
    this.state.currentSessionId === currentSessionId &&
    this.state.transcript === transcript &&
    transcript.historyGeneration === generation &&
    transcript.activeTurn === turn;
  if (!isCurrent()) return true;
  void hydrateGatewayHistoryForDisplay([message], {
    sessionKey,
    sessionId: currentSessionId,
    includeFailedRunOverlays: false,
    includeInterruptedOverlays: false,
  })
    .then(messages => {
      if (!isCurrent()) return;
      if (applyCompactionHistory.call(this, sessionKey, messages)) {
        this.notifyStream();
        this.notify();
      }
    })
    .catch(() => {
      /* Keep the visible node and any already confirmed metrics. */
    });
  return true;
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
  const transcript = this.isSelectedSession(sessionKey)
    ? this.state.transcript
    : this.findLiveSessionState(sessionKey)?.[1].transcript;
  for (const item of transcript?.activeTurn?.items ?? []) {
    if (item.type === 'compaction' && item.message?.__openclaw?.id === status.id) {
      item.message = undefined;
      transcript!.revision += 1;
    }
  }
  this.localCompactionStatusBySession.delete(sessionKey);
  this.deferredHistoryReloadAttempts.delete(sessionKey);
  this.updateLocalCompactionMessage(sessionKey, status.id, null);
}

function ownsManualCompactionPresentation(
  context: ChatControllerCompactionContext,
  operation: ManualCompactionOperation,
): boolean {
  const status = context.localCompactionStatusBySession.get(operation.sessionKey);
  if (status && status.id !== operation.status.id && status.eventId !== operation.status.eventId)
    return false;
  const live = context.isSelectedSession(operation.sessionKey)
    ? context.state
    : context.findLiveSessionState(operation.sessionKey)?.[1];
  return !(
    live &&
    (live.transcript.activeTurn?.status === 'running' ||
      (live.chatSending && (live.chatRunId || live.runActivity || live.pendingUserMessage)))
  );
}

export function restorePendingManualCompactions(
  this: ChatControllerCompactionContext,
  sessionKey?: string,
): void {
  for (const [id, operation] of this.manualCompactionOperations) {
    if (operation.nativeSettled || (sessionKey && !this.isSelectedSession(operation.sessionKey)))
      continue;
    if (!ownsManualCompactionPresentation(this, operation)) continue;
    const key = operation.sessionKey;
    this.localCompactionStatusBySession.set(key, operation.status);
    this.manualCompactionRequestIdsBySession.set(key, id);
    if (this.isSelectedSession(key)) {
      this.state.chatSending = true;
      this.state.compactionInFlight = true;
      this.setCurrentSessionMessages(
        this.projectLocalCompactionStatus(key, this.state.chatMessages),
      );
    } else {
      const cached = this.findLiveSessionState(key)?.[1];
      if (cached) {
        cached.chatSending = true;
        cached.compactionInFlight = true;
      }
      const history = this.chatMessagesBySession.get(key) ?? new ChunkedMessageHistory();
      history.replaceRecent(this.projectLocalCompactionStatus(key, history.recentMessages));
      this.chatMessagesBySession.set(key, history);
    }
  }
}

export async function reconcileManualCompactions(
  this: ChatControllerCompactionContext,
  client: NonNullable<ChatController['state']['client']>,
  generation: number,
): Promise<void> {
  if (
    !this.state.connected ||
    this.state.client !== client ||
    this.manualCompactionRecoveryGeneration !== generation
  )
    return;
  restorePendingManualCompactions.call(this);
  this.notifyStream();
  this.notify();
  await Promise.all(
    [...this.manualCompactionOperations].map(async ([id, operation]) => {
      const key = operation.sessionKey;
      const isCurrent = () =>
        this.state.connected &&
        this.state.client === client &&
        this.manualCompactionRecoveryGeneration === generation &&
        this.manualCompactionOperations.get(id) === operation;
      const validate = (receipt: CompactionOperationSnapshot) => {
        if (receipt?.operationId !== operation.operationId || receipt.key !== key) {
          throw new Error(i18nService.t('coworkStopFailed'));
        }
        if (
          receipt.phase === 'settled' &&
          !['completed', 'skipped', 'failed', 'aborted'].includes(receipt.outcome ?? '')
        ) {
          throw new Error(i18nService.t('coworkStopFailed'));
        }
        if (!['in-progress', 'settled', 'unknown'].includes(receipt.phase)) {
          throw new Error(i18nService.t('coworkStopFailed'));
        }
      };
      try {
        let receipt = await client.request<CompactionOperationSnapshot>(
          'sessions.compaction.status',
          {
            key,
            operationId: operation.operationId,
          },
        );
        if (!isCurrent()) return;
        validate(receipt);
        const resultUnknown = receipt.phase === 'unknown';
        if (resultUnknown) {
          // A restarted Gateway cannot attest to the old process's result.
          // Fence a delayed submission before releasing the local sending lock.
          operation.cancelled = true;
          receipt = await client.request<CompactionOperationSnapshot>('sessions.compaction.abort', {
            key,
            operationId: operation.operationId,
          });
          if (!isCurrent()) return;
          validate(receipt);
        }
        if (receipt.phase === 'in-progress') return;
        if (receipt.phase !== 'settled') throw new Error(i18nService.t('coworkStopFailed'));
        if (!ownsManualCompactionPresentation(this, operation)) {
          // A newer native card or run owns the presentation. Reconcile only
          // this old submission, including a confirmed cancellation tombstone.
          operation.nativeSettled = true;
          operation.settled = true;
          operation.error = undefined;
          this.manualCompactionOperations.delete(id);
          if (this.manualCompactionRequestIdsBySession.get(key) === id) {
            this.manualCompactionRequestIdsBySession.delete(key);
          }
          const oldStatus = this.localCompactionStatusBySession.get(key);
          if (oldStatus?.id === operation.status.id) {
            this.localCompactionStatusBySession.delete(key);
            this.updateLocalCompactionMessage(key, oldStatus.id, null);
            if (this.isSelectedSession(key)) this.notify();
          }
          this.settledCompactionEventIds.add(
            JSON.stringify([key, `operation:${operation.operationId}`]),
          );
          return;
        }
        if (resultUnknown) {
          operation.nativeSettled = true;
          operation.settled = true;
          operation.error = undefined;
          this.updateLocalCompactionMessage(key, id, {
            role: 'system',
            content: i18nService.t('coworkCompactPreviousResultUnknown'),
            timestamp: operation.status.message.timestamp,
          });
          this.localCompactionStatusBySession.delete(key);
          this.deferredHistoryReloadAttempts.delete(key);
          this.settledCompactionEventIds.add(
            JSON.stringify([key, `operation:${operation.operationId}`]),
          );
          this.manualCompactionOperations.delete(id);
          if (this.manualCompactionRequestIdsBySession.get(key) === id) {
            this.manualCompactionRequestIdsBySession.delete(key);
          }
          this.settleCompactionRequest(key);
        } else {
          handleCompactionPhase.call(this, 'end', key, {
            ...receipt,
            completed: receipt.outcome === 'completed',
          });
        }
        if (this.isSelectedSession(key) && ownsManualCompactionPresentation(this, operation)) {
          this.state.lastError = null;
          this.notifyStream();
          this.notify();
        }
      } catch (error) {
        if (!isCurrent()) return;
        // A rejected status read is not a terminal compaction receipt.
        if (this.isSelectedSession(key) && ownsManualCompactionPresentation(this, operation)) {
          this.state.lastError = (error as Error).message;
          this.notify();
        }
      }
    }),
  );
}

export function handleCompactionPhase(
  this: ChatControllerCompactionContext,
  phase: string,
  sessionKey = this.state.sessionKey,
  data: Record<string, unknown> = {},
): void {
  const isCurrentSession = this.isSelectedSession(sessionKey);
  const eventId = compactionEventId(data);
  const settledKey = eventId ? JSON.stringify([sessionKey, eventId]) : undefined;
  if (settledKey && this.settledCompactionEventIds.has(settledKey)) return;
  const transcript = isCurrentSession
    ? this.state.transcript
    : this.findLiveSessionState(sessionKey)?.[1].transcript;
  if (
    !this.localCompactionStatusBySession.has(sessionKey) &&
    findTurnCompaction(transcript?.activeTurn ?? null, eventId)
  ) {
    this.beginLocalCompactionStatus(sessionKey, { eventId });
  }
  const existing = this.localCompactionStatusBySession.get(sessionKey);
  let manualOperationSettled = false;
  let manualPresentationSuperseded = false;
  if (
    (phase === 'end' || phase === 'error' || phase === 'failed') &&
    typeof data.operationId === 'string'
  ) {
    for (const [id, operation] of this.manualCompactionOperations) {
      if (operation.sessionKey !== sessionKey || operation.operationId !== data.operationId)
        continue;
      manualPresentationSuperseded ||= !ownsManualCompactionPresentation(this, operation);
      operation.settled = true;
      operation.nativeSettled = true;
      operation.error = undefined;
      manualOperationSettled = true;
      this.manualCompactionOperations.delete(id);
      if (this.manualCompactionRequestIdsBySession.get(sessionKey) === id) {
        this.manualCompactionRequestIdsBySession.delete(sessionKey);
      }
    }
  }
  if (manualPresentationSuperseded) {
    if (settledKey) {
      this.settledCompactionEventIds.add(settledKey);
      if (this.settledCompactionEventIds.size > 256) {
        this.settledCompactionEventIds.delete(
          this.settledCompactionEventIds.values().next().value!,
        );
      }
    }
    return;
  }
  // A late terminal/update from the preceding compaction must not settle its successor.
  // Its own native receipt still retires the original submission identity.
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
  const outcome =
    data.outcome === 'failed' || data.outcome === 'skipped' || data.outcome === 'aborted'
      ? data.outcome
      : phase !== 'end'
        ? 'failed'
        : data.completed !== false
          ? 'completed'
          : isCompactionAbortReason(data.reason)
            ? 'aborted'
            : isBenignCompactionNoopReason(data.reason)
              ? 'skipped'
              : 'failed';
  const unsuccessful = outcome !== 'completed';
  const wasInProgress =
    this.localCompactionStatusBySession.get(sessionKey)?.message.__openclaw.phase === 'in-progress';
  const inProgressStatus = this.localCompactionStatusBySession.get(sessionKey);
  if (inProgressStatus && typeof data.markerExpected === 'boolean') {
    inProgressStatus.markerExpected = data.markerExpected;
  }
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
        phase: outcome,
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
  if (manualOperationSettled) this.settleCompactionRequest(sessionKey);
  if (!isCurrentSession) {
    const cached = this.findLiveSessionState(sessionKey)?.[1];
    if (cached) cached.compactionInFlight = false;
    return;
  }
  this.state.compactionInFlight = false;
  if (this.terminalLifecycleSeen) this.scheduleChatLifecycleEndFallback();
  if (
    status &&
    wasInProgress &&
    !unsuccessful &&
    status.markerExpected !== false &&
    !status.authoritativeMarkerSeen
  ) {
    this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
  }
  if (
    manualOperationSettled &&
    !unsuccessful &&
    status?.markerExpected === false &&
    this.state.connected &&
    !this.state.chatSending
  ) {
    // Native end retires the RPC identity before its reply arrives. A
    // marker-free manual commit still needs one authoritative history read.
    void this.loadHistory();
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
  // The native operation registry covers preparation and queued admission too.
  // Never use a session-wide no-active-run reply as proof this operation stopped.
  const needsConfirmation = (operation: (typeof operations)[number]) => !operation.nativeSettled;
  const retryDeadline = Date.now() + MANUAL_COMPACTION_STOP_RETRY_WINDOW_MS;
  while (operations.some(needsConfirmation)) {
    // Preparation may never register a native handle. Keep its admission
    // uncertain, but release the Stop control so the user can retry instead
    // of polling forever behind a disabled button. Each RPC is also bounded
    // by the Gateway client's transport timeout.
    if (Date.now() >= retryDeadline) throw new Error(i18nService.t('coworkStopFailed'));
    const operation = operations.find(needsConfirmation)!;
    const client = this.state.connected && this.state.client ? this.state.client : operation.client;
    let result: CompactionOperationSnapshot;
    try {
      result = await client.request<CompactionOperationSnapshot>('sessions.compaction.abort', {
        key: sessionKey,
        operationId: operation.operationId,
      });
    } catch (error) {
      if (operation.nativeSettled) continue;
      throw error;
    }
    if (operation.nativeSettled) continue;
    if (result.operationId !== operation.operationId || result.key !== sessionKey) {
      throw new Error(i18nService.t('coworkStopFailed'));
    }
    if (result.phase === 'settled') {
      if (!['completed', 'skipped', 'failed', 'aborted'].includes(result.outcome ?? '')) {
        throw new Error(i18nService.t('coworkStopFailed'));
      }
      operation.settled = true;
      operation.nativeSettled = true;
      operation.error = undefined;
      handleCompactionPhase.call(this, 'end', sessionKey, {
        ...result,
        completed: result.outcome === 'completed',
      });
    } else if (result.phase !== 'in-progress') {
      throw new Error(i18nService.t('coworkStopFailed'));
    }
    if (operations.some(needsConfirmation)) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const uncertain = operations.find(
    operation => operation.error && !isDefinitiveSessionGoalGatewayError(operation.error),
  );
  if (uncertain) throw uncertain.error;
  for (const [id, operation] of this.manualCompactionOperations) {
    if (operations.includes(operation)) {
      this.manualCompactionOperations.delete(id);
      if (this.manualCompactionRequestIdsBySession.get(sessionKey) === id) {
        this.manualCompactionRequestIdsBySession.delete(sessionKey);
      }
    }
  }
  if (operations.length > 0) {
    if (this.isSelectedSession(sessionKey) && !this.state.chatSending) {
      this.state.lastError = null;
      this.notifyStream();
      this.notify();
    }
  }
}

export async function compactSession(
  this: ChatControllerCompactionContext,
  argumentsText = '',
): Promise<void> {
  const client = this.state.client;
  if (!client || !this.state.connected) throw new Error('not connected');
  if (argumentsText.trim()) {
    const error = new Error(i18nService.t('coworkCompactArgumentsUnsupported'));
    this.state.lastError = error.message;
    this.notify();
    throw error;
  }
  const sessionKey = this.state.sessionKey;
  if (
    [...this.manualCompactionOperations.values()].some(
      operation => this.isSelectedSession(operation.sessionKey) && !operation.nativeSettled,
    )
  ) {
    throw new Error(i18nService.t('coworkCompactionInProgress'));
  }
  // The v2026.9.8 native lifecycle patch binds Stop to this single submission.
  // Inline instructions are not supported by the manual compaction RPC.
  const localStatus = this.beginLocalCompactionStatus(sessionKey, { forceNew: true });
  const statusId = localStatus.id;
  const operation = {
    sessionKey,
    operationId: crypto.randomUUID(),
    client,
    cancelled: false,
    settled: false,
    nativeSettled: false,
    status: localStatus,
    error: undefined as unknown,
  };
  localStatus.eventId = `operation:${operation.operationId}`;
  this.manualCompactionOperations.set(statusId, operation);
  this.manualCompactionRequestIdsBySession.set(sessionKey, statusId);
  const requestGeneration = this.manualCompactionRecoveryGeneration;
  const requestStillCurrent = (): boolean =>
    this.state.client === client &&
    this.manualCompactionRecoveryGeneration === requestGeneration &&
    this.manualCompactionRequestIdsBySession.get(sessionKey) === statusId;

  this.state.chatSending = true;
  this.state.compactionInFlight = true;
  this.state.lastError = null;
  this.notifyStream();
  this.notify();

  let responseReceived = false;
  try {
    const result = await client.request<{
      ok?: boolean;
      compacted?: boolean;
      reason?: string;
      outcome?: 'completed' | 'skipped' | 'failed' | 'aborted';
      markerExpected?: boolean;
      result?: { kind?: string; tokensBefore?: number; tokensAfter?: number };
    }>('sessions.compact', { key: sessionKey, operationId: operation.operationId });
    responseReceived = true;
    operation.settled = true;
    if (!requestStillCurrent()) return;
    if (result.outcome === 'aborted' || isCompactionAbortReason(result.reason)) {
      operation.nativeSettled = true;
      this.updateLocalCompactionMessage(sessionKey, statusId, {
        ...localStatus.message,
        __openclaw: { ...localStatus.message.__openclaw, phase: 'aborted', reason: result.reason },
      });
      this.localCompactionStatusBySession.delete(sessionKey);
      this.settleCompactionRequest(sessionKey);
      if (this.isSelectedSession(sessionKey)) {
        this.notifyStream();
        this.notify();
      }
      return;
    }
    if (
      result?.ok === false &&
      result.outcome !== 'skipped' &&
      !isBenignCompactionNoopReason(result.reason)
    ) {
      operation.nativeSettled = true;
      throw new Error(result.reason || i18nService.t('coworkCompactUnknownError'));
    }
    operation.nativeSettled = true;
    const before = result?.result?.tokensBefore;
    const after = result?.result?.tokensAfter;
    if (result?.compacted) {
      localStatus.markerExpected =
        result.markerExpected ?? (result.result?.kind === 'server-endpoint' ? false : undefined);
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
        if (localStatus.markerExpected !== false) {
          this.scheduleDeferredHistoryReload(sessionKey, 'compaction-marker-pending');
        }
        return;
      }
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
    if (operation.nativeSettled && !responseReceived) {
      if (requestStillCurrent()) {
        this.settleCompactionRequest(sessionKey);
        this.notifyStream();
        this.notify();
      }
      return;
    }
    operation.error = err;
    operation.settled = true;
    if (!requestStillCurrent()) return;
    if (!operation.nativeSettled && !isDefinitiveSessionGoalGatewayError(err)) {
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
    // A lost transport does not end native work. Keep its identity until a
    // terminal event, receipt or definitive admission failure establishes it.
    if (
      operation.nativeSettled ||
      (isDefinitiveSessionGoalGatewayError(operation.error) && requestStillCurrent())
    ) {
      this.manualCompactionOperations.delete(statusId);
      if (this.manualCompactionRequestIdsBySession.get(sessionKey) === statusId) {
        this.manualCompactionRequestIdsBySession.delete(sessionKey);
      }
    }
  }
}
