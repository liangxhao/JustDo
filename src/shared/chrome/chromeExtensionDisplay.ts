export const ChromeExtensionCompactionKind = {
  Completed: 'compaction',
  Status: 'compaction-status',
  Skipped: 'compaction-skipped',
} as const;

/** Authenticated presentation facts; none of these fields establishes execution outcome. */
export interface ChromeExtensionMessageDisplay {
  /** Native assistant message metadata; never a run completion or model-selection receipt. */
  timestampMs?: number;
  modelName?: string;
  nativeFailure?: true;
  stopReason?: 'error' | 'aborted';
  keepVisible?: true;
  kind?:
    | (typeof ChromeExtensionCompactionKind)[keyof typeof ChromeExtensionCompactionKind]
    | 'phase-boundary'
    | 'unsupported-content';
  phase?: string;
  sourceId?: string;
  sourceIndex?: number;
  sourceSegmentId?: string;
}
