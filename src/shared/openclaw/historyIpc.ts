// Keep aligned with the runtime bridge's bounded historyDetails RPC contract.
export const OPENCLAW_HISTORY_DETAIL_MAX_IDS = 250;

export const OpenClawHistoryIpc = {
  GetToolInputs: 'openclaw:history:getToolInputs',
  GetCompactionDetails: 'openclaw:history:getCompactionDetails',
} as const;

export interface OpenClawCompactionDetail {
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

export type OpenClawCompactionDetailLookup = Record<string, OpenClawCompactionDetail>;
