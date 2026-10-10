import { i18nService } from '@/services/i18n';

import type { NativeWidgetClient } from '../components/native-widget/host';

/** The prepared Main turn uses the actual presenting client; never retries an uncertain send. */
export async function dispatchInitialTurn(
  state: { client: NativeWidgetClient | null; connected: boolean; sessionKey: string },
  params: Record<string, unknown>,
): Promise<unknown> {
  if (
    !state.connected ||
    !state.client ||
    !state.sessionKey ||
    params.sessionKey !== state.sessionKey
  )
    throw Object.assign(new Error(i18nService.t('coworkInitialDispatchUnavailable')), {
      requestSent: false,
    });
  try {
    return await state.client.request('chat.send', params);
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
