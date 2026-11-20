export const SessionTitleIpc = {
  Generate: 'generate-session-title',
  Rename: 'cowork:session:rename',
} as const;

export interface GenerateSessionTitleRequest {
  userInput: string;
  sessionId: string;
  expectedTitle: string;
  nativeTarget: SessionTitleTarget;
}

export interface SessionTitleTarget {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
}

export interface RenameSessionRequest {
  sessionId: string;
  title: string;
}
