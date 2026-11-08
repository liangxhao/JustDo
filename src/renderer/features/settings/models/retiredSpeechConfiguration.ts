import { i18nService } from '@/services/i18n';

/** Retired authored metadata must be rejected before a whitelist can erase it. */
export function assertNoRetiredSpeechProfile(value: unknown): void {
  if (
    value &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'compatibilityProfile')
  ) {
    throw new Error(i18nService.t('speechBindingInvalid'));
  }
}
