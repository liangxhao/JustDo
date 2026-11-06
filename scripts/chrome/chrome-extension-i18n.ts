import { translations } from '../../src/renderer/services/i18n/translations';
export type LanguageType = 'zh' | 'en';

export const i18nService = {
  getLanguage: () =>
    navigator.language.toLowerCase().startsWith('zh') ? ('zh' as const) : ('en' as const),
  t(key: string): string {
    return translations[this.getLanguage()][key] || translations.en[key] || key;
  },
};
