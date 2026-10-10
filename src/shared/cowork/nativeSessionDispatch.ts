/** Initial UI turns use the actual rendering connection; Main still owns admission. */
export const NativeSessionDispatchIpc = {
  Request: 'cowork:session:native-dispatch:request',
  Respond: 'cowork:session:native-dispatch:respond',
} as const;

export interface NativeSessionDispatchRequest {
  requestId: string;
  clientTurnId: string;
  sessionId: string;
  sessionKey: string;
  params: Record<string, unknown>;
}

export interface NativeSessionDispatchResponse {
  requestId: string;
  clientTurnId: string;
  success: boolean;
  payload?: unknown;
  error?: string;
  gatewayCode?: string;
  requestSent?: boolean;
}
