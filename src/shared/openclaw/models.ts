export const OpenClawModelsIpc = {
  List: 'openclaw:models:list',
} as const;

export type OpenClawModelUnavailableReason = 'missing-auth' | 'auth-failed' | 'cooldown';

export interface OpenClawModelChoice {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  tags?: string[];
  available?: boolean;
  unavailableReason?: OpenClawModelUnavailableReason;
  unavailableUntil?: number;
  contextWindow?: number;
  reasoning?: boolean;
  supportsTools?: boolean;
  input?: Array<'text' | 'image' | 'audio' | 'video' | 'document'>;
}

export interface OpenClawModelsListResult {
  success: boolean;
  models: OpenClawModelChoice[];
  error?: string;
}
