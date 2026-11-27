import type { BuiltinModelAuthIssue } from '../providers/builtinModels';

export const NetworkIpc = {
  Fetch: 'api:fetch',
  CancelFetch: 'api:cancelFetch',
  TestBuiltinModel: 'api:testBuiltinModel',
  GetOutboundHeaderPolicy: 'network:getOutboundHeaderPolicy',
  OutboundHeaderPolicyChanged: 'network:outboundHeaderPolicyChanged',
} as const;

export const OutboundCookieRefreshStatus = {
  Unconfirmed: 'unconfirmed',
  Confirmed: 'confirmed',
  Failed: 'failed',
} as const;

export type OutboundCookieRefreshStatus =
  (typeof OutboundCookieRefreshStatus)[keyof typeof OutboundCookieRefreshStatus];

export interface OutboundHeaderPolicyView {
  enabled: boolean;
  targets: {
    url: string;
    headers: {
      name: string;
      sourceField: string | null;
      value: string | null;
      cookieRefreshStatus?: OutboundCookieRefreshStatus;
    }[];
  }[];
}

export const NetworkFetchPurpose = {
  ModelDiscovery: 'model-discovery',
  ModelConnectionTest: 'model-connection-test',
  NonLanguageModelDiscovery: 'non-language-model-discovery',
} as const;

export type NetworkFetchPurpose = (typeof NetworkFetchPurpose)[keyof typeof NetworkFetchPurpose];

export interface ApiFetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  requestId?: string;
  purpose?: NetworkFetchPurpose;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  error?: string;
}

export interface BuiltinModelProbeRequest {
  modelId: string;
  requestId: string;
}

export const BuiltinModelProbeOutcome = {
  Completed: 'completed',
  AuthenticationRejected: 'authentication-rejected',
  Interrupted: 'interrupted',
} as const;

export type BuiltinModelProbeResult =
  | { outcome: typeof BuiltinModelProbeOutcome.Completed; response: Omit<ApiResponse, 'headers'> }
  | { outcome: typeof BuiltinModelProbeOutcome.AuthenticationRejected; issue: BuiltinModelAuthIssue }
  | { outcome: typeof BuiltinModelProbeOutcome.Interrupted };

export const MODEL_CONNECTION_TEST_REQUEST_PURPOSE = 'connection_test';
export const MODEL_CONNECTION_TEST_MAX_TOKENS = 64;

export const buildModelConnectionTestRequestBody = (
  modelId: string,
  maxTokens: number,
  includeMetadata = false,
): string => JSON.stringify({
  model: modelId,
  ...(includeMetadata ? { metadata: { request_purpose: MODEL_CONNECTION_TEST_REQUEST_PURPOSE } } : {}),
  messages: [{ role: 'user', content: 'Hi' }],
  max_tokens: maxTokens,
});
