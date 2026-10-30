import { agentTeamTranslations } from '../../app/browser/translations';

let language: 'en' | 'zh' = 'en';
export const i18nService = {
  getLanguage: () => language,
  setLanguage(value: 'en' | 'zh', _options?: { persist?: boolean }) { language = value; },
  t(key: string) { return Reflect.get(agentTeamTranslations[language], key) ?? key; },
};
