import type {
  NativeSessionDispatchRequest,
  NativeSessionDispatchResponse,
} from '@shared/cowork/nativeSessionDispatch';
import { isGatewayRequestOutcomeUnknown } from '@shared/openclaw/gatewayRequestOutcome';

type DispatchApi = {
  onNativeSessionDispatch: (
    listener: (request: NativeSessionDispatchRequest) => void,
  ) => () => void;
  respondNativeSessionDispatch: (response: NativeSessionDispatchResponse) => Promise<unknown>;
};

/** Only the still-pending explicit user start can consume its one native dispatch. */
export function listenInitialSessionDispatch(
  api: DispatchApi,
  clientTurnId: string,
  dispatch: (request: NativeSessionDispatchRequest) => Promise<unknown>,
): () => void {
  let consumed = false;
  let active = true;
  const unsubscribe = api.onNativeSessionDispatch(request => {
    if (!active || request?.clientTurnId !== clientTurnId || consumed) return;
    if (
      request.params?.idempotencyKey !== clientTurnId ||
      request.params?.sessionKey !== request.sessionKey ||
      typeof request.requestId !== 'string' ||
      !request.requestId ||
      typeof request.sessionId !== 'string' ||
      !request.sessionId
    )
      return;
    consumed = true;
    void (async () => {
      let response: NativeSessionDispatchResponse;
      try {
        const payload = await dispatch(request);
        response = { requestId: request.requestId, clientTurnId, success: true, payload };
      } catch (error) {
        const failure = error as { message?: string; gatewayCode?: string; requestSent?: boolean };
        response = {
          requestId: request.requestId,
          clientTurnId,
          success: false,
          error: (failure?.message || 'Initial chat dispatch failed.').slice(0, 2000),
          ...(typeof failure?.gatewayCode === 'string'
            ? { gatewayCode: failure.gatewayCode.slice(0, 100) }
            : {}),
          requestSent: isGatewayRequestOutcomeUnknown(error) || failure?.requestSent === true,
        };
      }
      // An ACK after disposal still belongs to this exact Main operation. Return
      // it once; never retry a request whose native admission may have succeeded.
      await api.respondNativeSessionDispatch(response).catch(() => undefined);
    })();
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
