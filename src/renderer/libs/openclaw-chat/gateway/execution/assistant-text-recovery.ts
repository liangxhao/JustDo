import { normalizeAgentEvent, type NormalizedAgentEvent } from '@shared/openclaw/agentEvent';

import {
  type AssistantTurn,
  type ChatTranscriptState,
  normalizeTranscriptSessionKey,
  type TranscriptReducerDependencies,
} from '../../model/chat-transcript-state';
import { reduceAgentEvent } from '../../model/turn/agent-event-reducer';
import type { GatewayClient } from '../client';

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_REQUEST_TIMEOUT_MS = 10_000;

type RecoveryState = { attempts: number; flight?: Promise<boolean> };
const recoveryByTurn = new WeakMap<AssistantTurn, RecoveryState>();

export interface AssistantTextRecoveryContext {
  transcript: ChatTranscriptState;
  client: Pick<GatewayClient, 'generation' | 'request'> | null;
  dependencies: TranscriptReducerDependencies;
  /** Recheck the current controller/session binding without retaining copied authority. */
  isCurrent: () => boolean;
  notify: () => void;
}

/** Marker/empty frames do not establish a body lane; legacy unkeyed text still can. */
export function hasSelectedAssistantTextSource(
  turn: AssistantTurn | null,
  data: Record<string, unknown>,
  text: string | null,
): boolean {
  return (
    turn?.assistantTextSourceSelected === true ||
    Boolean(
      text?.trim() &&
      !turn?.items.some(item => item.type === 'content' && item.chatFallback) &&
      ![data.itemId, data.id].some(value => typeof value === 'string' && value.trim()),
    )
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameSession(left: unknown, right: string): boolean {
  return (
    typeof left === 'string' &&
    normalizeTranscriptSessionKey(left) === normalizeTranscriptSessionKey(right)
  );
}

/** Recover an admitted owner's complete native baseline; never splice unknown deltas. */
export function recoverAssistantText(context: AssistantTextRecoveryContext): Promise<boolean> {
  const { transcript, client } = context;
  const turn = transcript.activeTurn;
  if (!client || !turn || turn.status !== 'running' || !turn.assistantTextRecoveryOwnerIds?.size)
    return Promise.resolve(false);
  let state = recoveryByTurn.get(turn);
  if (!state) {
    state = { attempts: 0 };
    recoveryByTurn.set(turn, state);
  }
  if (state.flight) return state.flight;
  if (state.attempts >= MAX_RECOVERY_ATTEMPTS) return Promise.resolve(false);

  const sessionKey = transcript.sessionKey;
  const runId = turn.runId;
  const turnSessionKey = turn.sessionKey;
  const sessionId = transcript.sessionId;
  const turnSessionId = turn.sessionId;
  const lifecycleGeneration = turn.lifecycleGeneration;
  const historyGeneration = transcript.historyGeneration;
  const clientGeneration = client.generation;
  const current = () =>
    context.isCurrent() &&
    client.generation === clientGeneration &&
    transcript.sessionKey === sessionKey &&
    transcript.sessionId === sessionId &&
    transcript.historyGeneration === historyGeneration &&
    transcript.activeTurn === turn &&
    turn.runId === runId &&
    turn.sessionKey === turnSessionKey &&
    turn.status === 'running' &&
    turn.sessionId === turnSessionId &&
    turn.lifecycleGeneration === lifecycleGeneration;

  const recoveryState = state;
  const flight = (async () => {
    let recovered = false;
    while (
      current() &&
      turn.assistantTextRecoveryOwnerIds?.size &&
      recoveryState.attempts < MAX_RECOVERY_ATTEMPTS
    ) {
      const owners = new Set(turn.assistantTextRecoveryOwnerIds);
      // Chat may carry a Tool/item flush boundary rather than an assistant seq.
      // Only this request's causal read can attest coverage of that boundary.
      const coveredThrough = Math.max(
        -1,
        ...turn.items.flatMap(item =>
          item.type === 'content' && item.chatFallback && item.chatSourceSeq !== undefined
            ? [item.chatSourceSeq]
            : [],
        ),
      );
      recoveryState.attempts += 1;
      let response: unknown;
      try {
        response = await client.request(
          'chat.history',
          { sessionKey, limit: 1 },
          {
            timeoutMs: RECOVERY_REQUEST_TIMEOUT_MS,
          },
        );
      } catch {
        continue;
      }
      if (!current()) break;
      const payload = record(response);
      const info = record(payload?.sessionInfo);
      const snapshot = record(payload?.inFlightRun);
      const responseSessionId = payload?.sessionId ?? info?.sessionId;
      const expectedSessionId = turnSessionId ?? sessionId;
      if (
        !payload ||
        !snapshot ||
        snapshot.runId !== runId ||
        (payload.sessionKey !== undefined && !sameSession(payload.sessionKey, sessionKey)) ||
        (info?.key !== undefined && !sameSession(info.key, sessionKey)) ||
        (expectedSessionId !== null && responseSessionId !== expectedSessionId) ||
        (payload.sessionId !== undefined &&
          info?.sessionId !== undefined &&
          payload.sessionId !== info.sessionId) ||
        info?.hasActiveRun === false ||
        (Array.isArray(info?.activeRunIds) && !info.activeRunIds.includes(runId)) ||
        !Array.isArray(snapshot.events)
      )
        continue;
      const events = snapshot.events
        .flatMap(value => {
          const event = record(value);
          const data = record(event?.data);
          if (
            !event ||
            event.runId !== runId ||
            event.stream !== 'assistant' ||
            data?.assistantTextSnapshot !== true ||
            typeof data.text !== 'string' ||
            typeof data.itemId !== 'string' ||
            !owners.has(data.itemId)
          )
            return [];
          const normalized = normalizeAgentEvent({
            deliveryEvent: 'agent',
            payload: event,
            allowAseqFallback: false,
          }).event;
          if (
            !normalized ||
            (normalized.sessionKey !== null && !sameSession(normalized.sessionKey, sessionKey)) ||
            (normalized.sessionId !== null &&
              expectedSessionId !== null &&
              normalized.sessionId !== expectedSessionId) ||
            (normalized.sessionId !== null &&
              typeof responseSessionId === 'string' &&
              normalized.sessionId !== responseSessionId) ||
            (normalized.lifecycleGeneration !== null &&
              lifecycleGeneration !== null &&
              normalized.lifecycleGeneration !== lifecycleGeneration)
          )
            return [];
          const admitted: NormalizedAgentEvent = {
            ...normalized,
            sessionKey: normalized.sessionKey ?? sessionKey,
            sessionId: normalized.sessionId ?? expectedSessionId,
            lifecycleGeneration: normalized.lifecycleGeneration ?? lifecycleGeneration,
            data: { ...normalized.data, replace: true },
          };
          return [admitted];
        })
        .sort((left, right) => left.agentSeq - right.agentSeq);
      for (const event of events) {
        if (!current()) break;
        if (!turn.assistantTextRecoveryOwnerIds?.has(String(event.data.itemId))) continue;
        const result = reduceAgentEvent(transcript, event, context.dependencies, {
          replaySnapshot: true,
          allowSequenceBackfill: true,
          chatFallbackCoveredThrough: coveredThrough,
        });
        if (result === 'applied') {
          recovered = true;
          context.notify();
        }
      }
    }
    return recovered;
  })().catch(() => false);
  state.flight = flight;
  const clearFlight = () => {
    if (recoveryState.flight === flight) delete recoveryState.flight;
  };
  void flight.then(clearFlight, clearFlight);
  return flight;
}
