export const CoworkSessionSearchIpc = {
  SearchMessages: 'cowork:session:searchMessages',
} as const;

export type CoworkSessionSearchRole = 'user' | 'assistant';

export interface CoworkSessionMessageSearchMatch {
  sessionId: string;
  role: CoworkSessionSearchRole;
  snippet: string;
  timestamp: number;
  score: number;
}

export type CoworkSessionMessageSearchResult =
  | {
      success: true;
      matches: CoworkSessionMessageSearchMatch[];
      indexing: boolean;
      truncated: boolean;
      partial: boolean;
    }
  | {
      success: false;
      error: string;
    };
