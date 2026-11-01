import { i18nService } from '@/services/i18n';

export const BROWSER_TAB_CAPACITY_EVENT = 'browser:tab-capacity-reached';

export function reportBrowserTabCapacity(sessionKey: string): void {
  const handled = !window.dispatchEvent(
    new CustomEvent(BROWSER_TAB_CAPACITY_EVENT, { detail: { sessionKey }, cancelable: true }),
  );
  if (!handled) {
    window.dispatchEvent(
      new CustomEvent('app:showToast', {
        detail: { message: i18nService.t('browserTabCapacityFallback'), tone: 'warning' },
      }),
    );
  }
}
