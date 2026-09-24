import { browserRecordingTranslations } from '@/features/browser/browserRecordingTranslations';
import type { LanguageType } from '@/services/i18n';

import { appTranslations } from './appTranslations';
import { chatTranslations } from './chatTranslations';
import { getHomeGreetingTranslations } from './homeGreetings';
import { pluginsTranslations } from './pluginsTranslations';
import { scheduledTaskTranslations } from './scheduledTaskTranslations';
import { settingsTranslations } from './settingsTranslations';

export const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    ...browserRecordingTranslations.zh,
    ...getHomeGreetingTranslations('zh'),
    ...appTranslations.zh,
    ...settingsTranslations.zh,
    ...chatTranslations.zh,
    ...pluginsTranslations.zh,
    ...scheduledTaskTranslations.zh,
  },
  en: {
    ...browserRecordingTranslations.en,
    ...getHomeGreetingTranslations('en'),
    ...appTranslations.en,
    ...settingsTranslations.en,
    ...chatTranslations.en,
    ...pluginsTranslations.en,
    ...scheduledTaskTranslations.en,
  },
};
