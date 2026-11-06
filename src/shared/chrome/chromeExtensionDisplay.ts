export const ChromeExtensionCompactionKind = {
  Completed: 'compaction',
  Status: 'compaction-status',
  Skipped: 'compaction-skipped',
} as const;

/** Authenticated presentation facts; none of these fields establishes execution outcome. */
export interface ChromeExtensionMessageDisplay {
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
