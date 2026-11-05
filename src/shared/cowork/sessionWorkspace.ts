export const SessionWorkspaceIpc = {
  Set: 'cowork:session:setWorkspace',
} as const;

export const SessionWorkspaceFailure = {
  Invalid: 'invalid',
  Unsupported: 'unsupported',
  Busy: 'busy',
  Unknown: 'unknown',
  PreparationUnknown: 'preparation-unknown',
  Changed: 'changed',
  Unavailable: 'unavailable',
} as const;

export type SessionWorkspaceFailure =
  (typeof SessionWorkspaceFailure)[keyof typeof SessionWorkspaceFailure];

export interface SetSessionWorkspaceInput {
  sessionId: string;
  /** Prevent a stale picker from overwriting a later selection. */
  expectedCwd: string;
  cwd: string;
}

export type SetSessionWorkspaceResult =
  { success: true; cwd: string } | { success: false; reason: SessionWorkspaceFailure };
