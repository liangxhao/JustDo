import { readTranscriptIdentity } from './transcript-identity';

export const HISTORY_RENDER_WINDOW_SIZE = 750;
export const HISTORY_RENDER_WINDOW_STEP = 250;

export interface HistoryRenderWindow {
  start: number;
  end: number;
}

export function latestHistoryWindow(
  messageCount: number,
  size = HISTORY_RENDER_WINDOW_SIZE,
): HistoryRenderWindow {
  const end = Math.max(0, messageCount);
  return { start: Math.max(0, end - size), end };
}

export function preserveHistoryWindow(
  previousMessages: unknown[],
  nextMessages: unknown[],
  previousWindow: HistoryRenderWindow,
  size = HISTORY_RENDER_WINDOW_SIZE,
): HistoryRenderWindow {
  if (previousMessages.length === 0 || previousWindow.end <= previousWindow.start) {
    return latestHistoryWindow(nextMessages.length, size);
  }

  const wasAtLatest = previousWindow.end >= previousMessages.length;
  if (wasAtLatest) return latestHistoryWindow(nextMessages.length, size);

  const firstVisible = previousMessages[previousWindow.start];
  const identity = readTranscriptIdentity(firstVisible);
  if (identity) {
    const nextStart = nextMessages.findIndex(message => {
      const candidate = readTranscriptIdentity(message);
      return candidate?.kind === identity.kind && candidate.value === identity.value;
    });
    if (nextStart >= 0) {
      const visibleLength = Math.min(size, previousWindow.end - previousWindow.start);
      return {
        start: nextStart,
        end: Math.min(nextMessages.length, nextStart + visibleLength),
      };
    }
  }

  const start = Math.min(previousWindow.start, Math.max(0, nextMessages.length - size));
  return { start, end: Math.min(nextMessages.length, start + size) };
}

export function shiftHistoryWindowOlder(
  window: HistoryRenderWindow,
  messageCount: number,
  size = HISTORY_RENDER_WINDOW_SIZE,
  step = HISTORY_RENDER_WINDOW_STEP,
): HistoryRenderWindow {
  if (window.start <= 0) return window;
  const start = Math.max(0, window.start - step);
  return { start, end: Math.min(messageCount, start + size) };
}

export function shiftHistoryWindowNewer(
  window: HistoryRenderWindow,
  messageCount: number,
  size = HISTORY_RENDER_WINDOW_SIZE,
  step = HISTORY_RENDER_WINDOW_STEP,
): HistoryRenderWindow {
  if (window.end >= messageCount) return window;
  const end = Math.min(messageCount, window.end + step);
  return { start: Math.max(0, end - size), end };
}
