export const OpenClawHistoryIpc = {
  GetToolInputs: 'openclaw:history:getToolInputs',
  GetPagedHistory: 'openclaw:history:getPagedHistory',
} as const;

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
