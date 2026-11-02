import { i18nService } from '@/services/i18n';

import { getConnectivityErrorMessage } from './providerSettingsConfig';

type ModelDiscoveryResponse = Pick<
  Awaited<ReturnType<Window['electron']['api']['fetch']>>,
  'status' | 'statusText' | 'data' | 'error'
>;

const getTransportErrorHint = (detail: string): string => {
  if (/ERR_CONNECTION_(CLOSED|RESET)/i.test(detail)) {
    return i18nService.t('modelDiscoveryConnectionClosed');
  }
  if (/ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)/i.test(detail)) {
    return i18nService.t('modelDiscoveryHostNotFound');
  }
  if (/ERR_CONNECTION_REFUSED/i.test(detail)) {
    return i18nService.t('modelDiscoveryConnectionRefused');
  }
  return i18nService.t('modelDiscoveryNoHttpResponse');
};

export const formatModelDiscoveryError = (response: ModelDiscoveryResponse): string => {
  const serverMessage = getConnectivityErrorMessage(response.data)?.trim();
  if (response.status > 0) {
    const status = `HTTP ${response.status} ${response.statusText}`.trim();
    const detail = serverMessage || response.error?.trim();
    return [
      status,
      detail,
      response.status === 404 ? i18nService.t('modelDiscoveryEndpointNotFound') : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const detail = response.error?.trim() || response.statusText.trim() || serverMessage;
  return [getTransportErrorHint(detail ?? ''), detail].filter(Boolean).join('\n');
};
