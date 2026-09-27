export const SessionReviewIpc = {
  Load: 'cowork:sessionReview:load',
  File: 'cowork:sessionReview:file',
} as const;
export const REVIEW_TAB_ID = 'session-review';
export const REVIEW_OPEN_EVENT = 'cowork:open-review';
export const ReviewScope = { All: 'all', Uncommitted: 'uncommitted', Commit: 'commit' } as const;
export type SessionReviewQuery = {
  sessionId: string;
  scope: 'all' | 'uncommitted' | 'commit';
  commit?: string;
};
export interface SessionReviewFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  untracked?: boolean;
  patch?: string;
  truncated?: boolean;
}
export interface SessionReviewDiff {
  sessionKey: string;
  root?: string;
  branch?: string;
  baseRef?: string;
  aheadCount?: number;
  commits?: { sha: string; subject: string }[];
  mergeBase?: { sha: string; subject: string };
  files: SessionReviewFile[];
  additions: number;
  deletions: number;
  truncated?: boolean;
  unavailableReason?: 'unknown_session' | 'not_git' | 'unknown_commit' | 'workspace_stopped';
}
export type SessionReviewError = 'unavailable' | 'unsupported' | 'identity' | 'invalid' | 'file';
export type SessionReviewResult =
  { success: true; diff: SessionReviewDiff } | { success: false; reason: SessionReviewError };
export type SessionReviewFileAction = 'preview' | 'files' | 'editor';
export type SessionReviewFileResult =
  | { success: true; filePath: string; relativePath: string }
  | { success: false; reason: SessionReviewError };
