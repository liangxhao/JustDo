export interface ComposerSubmissionMetadata {
  startedAt: number;
}

/** Preserve the human Send click across model and composer preparation. */
export function resolveComposerSubmissionStartedAt(metadata?: ComposerSubmissionMetadata): number {
  return metadata && Number.isFinite(metadata.startedAt) && metadata.startedAt > 0
    ? metadata.startedAt
    : Date.now();
}
