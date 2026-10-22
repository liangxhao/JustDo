export const BrowserExtensionCompactionKind = {
  Completed: 'compaction',
  Status: 'compaction-status',
  Skipped: 'compaction-skipped',
} as const;

/** Authenticated presentation facts; none of these fields establishes execution outcome. */
export interface BrowserExtensionMessageDisplay {
  nativeFailure?: true;
  stopReason?: 'error' | 'aborted';
  keepVisible?: true;
  kind?:
    | (typeof BrowserExtensionCompactionKind)[keyof typeof BrowserExtensionCompactionKind]
    | 'phase-boundary'
    | 'unsupported-content';
  phase?: string;
  sourceId?: string;
  sourceIndex?: number;
  sourceSegmentId?: string;
}
