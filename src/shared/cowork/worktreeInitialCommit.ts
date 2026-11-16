export const WorktreeInitialCommitIpc = {
  Confirm: 'cowork:worktree:confirm-initial-commit',
  Dismiss: 'cowork:worktree:dismiss-initial-commit',
} as const;

export interface WorktreeInitialCommitFile {
  path: string;
  staged: boolean;
}

export interface WorktreeInitialCommitOffer {
  id: string;
  projectRoot: string;
  files: WorktreeInitialCommitFile[];
}

export interface WorktreeInitialCommitInput {
  id: string;
  paths: string[];
}

export interface WorktreeInitialCommitResult {
  success: boolean;
  error?: string;
}
