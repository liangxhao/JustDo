import type { SendMotionOrigin } from '@/libs/openclaw-chat/components/message/send-motion';

export interface ComposerSubmissionMetadata {
  startedAt: number;
  sendMotionOrigin?: SendMotionOrigin;
  /** Recheck ordinary composer followup eligibility after asynchronous admission. */
  canQueueFollowup?: () => boolean;
  isDraftCurrent?: () => boolean;
}

// The same draft can outlive a composer mount while its acknowledgement is pending.
const draftLifetimes = new Map<string, object>();

export function captureComposerDraftLifetime(draftKey: string): () => boolean {
  const lifetime = draftLifetimes.get(draftKey) ?? {};
  draftLifetimes.set(draftKey, lifetime);
  return () => draftLifetimes.get(draftKey) === lifetime;
}

export function clearComposerDraftLifetime(draftKey: string): void {
  draftLifetimes.delete(draftKey);
}

/** Preserve the human Send click across model and composer preparation. */
export function resolveComposerSubmissionStartedAt(metadata?: ComposerSubmissionMetadata): number {
  return metadata && Number.isFinite(metadata.startedAt) && metadata.startedAt > 0
    ? metadata.startedAt
    : Date.now();
}
