import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import {
  isGatewayInjectedModelRef,
  modelRefFromIdentity,
  readModelRef,
} from '@shared/openclaw/modelRef';

import type { AssistantTurnTiming } from './chat-transcript-state';

export interface ActiveTurnFooter {
  completedAt: number | null;
  durationMs: number;
  running: boolean;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  modelRef?: string;
}

/** Resolve live and durable timing without allowing an older run to override a newer one. */
export function selectActiveTurnTiming(
  controllerTurn: AssistantTurnTiming | null,
  latestRunTiming: SessionRunTiming | null,
  hasActiveTurn: boolean,
): AssistantTurnTiming | SessionRunTiming | null {
  if (!controllerTurn) return latestRunTiming;
  if (!latestRunTiming) return controllerTurn;
  if (
    latestRunTiming.rootRunId === controllerTurn.runId ||
    latestRunTiming.clientTurnId === controllerTurn.runId
  ) {
    // Main owns lifecycle timing. Only Gateway owns the model actually used;
    // the receipt may contain a selection captured before a live switch.
    return {
      ...controllerTurn,
      startedAt: latestRunTiming.startedAt,
      endedAt: latestRunTiming.endedAt,
      status:
        latestRunTiming.state === 'completed'
          ? 'final'
          : latestRunTiming.state === 'failed'
            ? 'error'
            : latestRunTiming.state,
    };
  }
  if (!hasActiveTurn) return latestRunTiming;
  const controllerRunning = controllerTurn.status === 'running';
  const durableRunning = latestRunTiming.state === 'running';
  if (controllerRunning !== durableRunning)
    return controllerRunning ? controllerTurn : latestRunTiming;
  return latestRunTiming.startedAt > controllerTurn.startedAt ? latestRunTiming : controllerTurn;
}

/**
 * Resolve the model for the live turn without treating OpenClaw's internal
 * gateway-injected assistant records as model output. Progress metadata is
 * authoritative for the current run; history is only a display fallback.
 */
export function resolveActiveTurnModel(
  messages: readonly unknown[],
  currentModel?: unknown,
  currentProvider?: unknown,
): string {
  const progressModel = modelRefFromIdentity(currentModel, currentProvider);
  if (progressModel && !isGatewayInjectedModelRef(progressModel)) return progressModel;

  let currentTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if (String((message as Record<string, unknown>).role ?? '').toLowerCase() === 'user') {
      currentTurnStart = index;
      break;
    }
  }
  if (currentTurnStart < 0) return '';
  for (let index = messages.length - 1; index > currentTurnStart; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const role = String((message as Record<string, unknown>).role ?? '').toLowerCase();
    if (role !== 'assistant') continue;
    const modelRef = readModelRef(message);
    if (modelRef && !isGatewayInjectedModelRef(modelRef)) return modelRef;
  }
  return '';
}

/**
 * Keep the turn metadata attached to the live timeline, including while its
 * last visible row is Thinking or Tool rather than Content.
 */
export function projectActiveTurnFooter(
  turn: AssistantTurnTiming | SessionRunTiming | null,
  now = Date.now(),
): ActiveTurnFooter | null {
  if (!turn) return null;
  const running = 'state' in turn ? turn.state === 'running' : turn.status === 'running';
  const status =
    'state' in turn
      ? turn.state
      : turn.status === 'final'
        ? 'completed'
        : turn.status === 'error'
          ? 'failed'
          : turn.status;
  const completedAt = running ? null : (turn.endedAt ?? turn.startedAt);
  const durationEnd = running ? Math.max(now, turn.startedAt) : (completedAt ?? turn.startedAt);
  return {
    completedAt,
    durationMs: Math.max(0, durationEnd - turn.startedAt),
    running,
    status,
    ...(!('state' in turn) && turn.modelRef ? { modelRef: turn.modelRef } : {}),
  };
}

export function shouldRenderInterruptedTerminalFallback(
  footer: ActiveTurnFooter | null,
  hasVisibleInterruptedTerminal: boolean,
): boolean {
  return footer?.status === 'aborted' && !hasVisibleInterruptedTerminal;
}

export function formatActiveTurnTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function formatActiveTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 || hours > 0 ? `${minutes}m` : '',
    `${seconds}s`,
  ]
    .filter(Boolean)
    .join(' ');
}
