import type { AssistantTurnTiming } from './chat-transcript-state';

export interface ActiveTurnFooter {
  completedAt: number | null;
  durationMs: number;
  running: boolean;
}

/**
 * Keep the turn metadata attached to the live timeline, including while its
 * last visible row is Thinking or Tool rather than Content.
 */
export function projectActiveTurnFooter(
  turn: AssistantTurnTiming | null,
  now = Date.now(),
): ActiveTurnFooter | null {
  if (!turn) return null;
  const running = turn.status === 'running';
  const completedAt = running ? null : (turn.endedAt ?? turn.startedAt);
  const durationEnd = running
    ? Math.max(now, turn.startedAt)
    : (completedAt ?? turn.startedAt);
  return {
    completedAt,
    durationMs: Math.max(0, durationEnd - turn.startedAt),
    running,
  };
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
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}
