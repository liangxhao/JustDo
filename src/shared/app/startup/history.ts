/** A historical association, independent of native worktree adoption or live external ingress. */
export type HistorySessionBinding = {
  sessionKey: string;
  nativeSessionId: string;
  availability: 'native' | 'cache' | 'missing';
  workspaceUnavailable?: boolean;
};

export const HistoryRecoveryIpc = { SelectWorkspace: 'startup:history:selectWorkspace' } as const;
export type HistoryWorkspaceResult = {
  success: boolean;
  cancelled?: boolean;
  cwd?: string;
  error?: string;
};

export const HistoryRecoveryKind = {
  Space: 'space',
  Busy: 'busy',
  Access: 'access',
  Changing: 'changing',
  Other: 'other',
} as const;
export type HistoryRecoveryKind = (typeof HistoryRecoveryKind)[keyof typeof HistoryRecoveryKind];

export const StartupSupportAction = {
  OpenData: 'openData',
  OpenBackup: 'openBackup',
  OpenTaskManager: 'openTaskManager',
} as const;
export type StartupSupportAction = (typeof StartupSupportAction)[keyof typeof StartupSupportAction];
export const StartupSupportIpc = { Open: 'startup:support:open' } as const;
export type StartupSupportResult = { success: boolean };
