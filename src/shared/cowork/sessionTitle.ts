export const SessionTitleIpc = {
  Generate: 'generate-session-title',
} as const;

export interface GenerateSessionTitleRequest {
  userInput: string | null;
  sessionId: string;
}
