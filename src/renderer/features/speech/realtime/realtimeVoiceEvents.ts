import type { RealtimeVoiceTimelineUpdate } from '@shared/speech/realtimeVoice';

const listeners = new Set<(update: RealtimeVoiceTimelineUpdate) => void>();

/** Only the media controller publishes, after its native call/source admission. */
export function publishRealtimeVoiceTimeline(update: RealtimeVoiceTimelineUpdate): void {
  for (const listener of listeners) {
    try { listener(update); } catch { /* A detached view cannot interrupt media cleanup. */ }
  }
}

/** Unbuffered native stream delivery. The chat controller owns its display projection. */
export function subscribeRealtimeVoiceTimeline(
  listener: (update: RealtimeVoiceTimelineUpdate) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
