export const OpenClawHistoryIpc = {
  GetToolInputs: 'openclaw:history:getToolInputs',
  GetCompactionDetails: 'openclaw:history:getCompactionDetails',
  GetPagedHistory: 'openclaw:history:getPagedHistory',
} as const;

export interface OpenClawCompactionDetail {
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

export type OpenClawCompactionDetailLookup = Record<string, OpenClawCompactionDetail>;

export interface OpenClawPagedHistoryParams {
  sessionKey: string;
  cursor?: string;
  limit?: number;
}

export interface OpenClawPagedHistoryResult {
  success: boolean;
  messages?: unknown[];
  hasMore?: boolean;
  nextCursor?: string;
  error?: string;
}
