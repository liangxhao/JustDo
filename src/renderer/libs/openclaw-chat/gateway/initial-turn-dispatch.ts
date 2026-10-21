import { i18nService } from '@/services/i18n';

import type { NativeWidgetClient } from '../components/native-widget/host';
import type { GatewayClient } from './client';
import { hasMcpAppCanvasPreparations, prepareMcpAppChatSend } from './mcp-app-session';

/** The prepared Main turn uses the actual presenting client; never retries an uncertain send. */
export async function dispatchInitialTurn(
  state: {
    client: NativeWidgetClient | null;
    connected: boolean;
    sessionKey: string;
    currentSessionId?: string | null;
  },
  params: Record<string, unknown>,
  beforeRequest?: () => void,
  isCancelled: () => boolean = () => false,
): Promise<unknown> {
  if (
    isCancelled() ||
    !state.connected ||
    !state.client ||
    !state.sessionKey ||
    params.sessionKey !== state.sessionKey
  )
    throw Object.assign(new Error(i18nService.t('coworkInitialDispatchUnavailable')), {
      requestSent: false,
    });
  const client = state.client as GatewayClient;
  const generation = client.generation;
  const nativeSessionId = state.currentSessionId;
  let prepared: { method: string; params: Record<string, unknown> };
  try {
    const target = {
      client,
      generation,
      sessionKey: state.sessionKey,
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
      agentId: /^agent:([^:]+):/.exec(state.sessionKey)?.[1],
      isCurrent: () =>
        !isCancelled() &&
        state.client === client &&
        state.connected &&
        state.sessionKey === params.sessionKey &&
        client.generation === generation &&
        (state.currentSessionId === nativeSessionId ||
          (!nativeSessionId && state.currentSessionId === params.sessionId)) &&
        (typeof params.sessionId !== 'string' ||
          !state.currentSessionId ||
          state.currentSessionId === params.sessionId),
    };
    prepared = hasMcpAppCanvasPreparations(target)
      ? await prepareMcpAppChatSend(target, params)
      : { method: 'chat.send', params };
    if (!target.isCurrent()) throw new Error(i18nService.t('coworkInitialDispatchCancelled'));
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('Diagram preparation failed'), {
      requestSent: false,
    });
  }
  beforeRequest?.();
  try {
    return await client.request(prepared.method, prepared.params);
  } catch (error) {
    const failure = error as { requestSent?: unknown; gatewayCode?: unknown };
    if (failure?.requestSent === false || typeof failure?.gatewayCode === 'string') throw error;
    // Once the actual client was invoked, an unclassified transport failure must
    // remain uncertain. It cannot be treated as safe to replay by Main.
    throw Object.assign(
      error instanceof Error ? error : new Error('Initial turn outcome unknown'),
      {
        requestSent: true,
      },
    );
  }
}
