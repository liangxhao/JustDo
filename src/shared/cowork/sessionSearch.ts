export const CoworkSessionSearchIpc = {
  SearchMessages: 'cowork:session:searchMessages',
} as const;

export type CoworkSessionSearchRole = 'user' | 'assistant';

export interface CoworkSessionMessageSearchMatch {
  sessionId: string;
  nativeSessionKey: string;
  nativeSessionId: string;
  messageId: string;
  role: CoworkSessionSearchRole;
  snippet: string;
  timestamp: number;
  score: number;
}

export interface CoworkSessionSearchOptions {
  sessionIds?: string[];
  excludeSessionIds?: string[];
}

export type CoworkSessionMessageSearchResult =
  | {
      success: true;
      matches: CoworkSessionMessageSearchMatch[];
      indexing: boolean;
      truncated: boolean;
      partial: boolean;
      archivedTranscriptsExcluded: number;
    }
  | {
      success: false;
      error: string;
    };
