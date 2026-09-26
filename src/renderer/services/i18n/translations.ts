import { browserInterventionTranslations } from '@/features/browser/browserInterventionTranslations';
import { browserRecordingTranslations } from '@/features/browser/browserRecordingTranslations';
import type { LanguageType } from '@/services/i18n';

import { appTranslations } from './appTranslations';
import { chatTranslations } from './chatTranslations';
import { getHomeGreetingTranslations } from './homeGreetings';
import { pluginsTranslations } from './pluginsTranslations';
import { scheduledTaskTranslations } from './scheduledTaskTranslations';
import { sessionStorageTranslations } from './sessionStorageTranslations';
import { settingsTranslations } from './settingsTranslations';
import { skillWorkshopTranslations } from './skillWorkshopTranslations';

export const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    ...sessionStorageTranslations.zh,
    ...browserInterventionTranslations.zh,
    ...skillWorkshopTranslations.zh,
    ...browserRecordingTranslations.zh,
    ...getHomeGreetingTranslations('zh'),
    ...appTranslations.zh,
    ...settingsTranslations.zh,
    ...chatTranslations.zh,
    ...pluginsTranslations.zh,
    ...scheduledTaskTranslations.zh,
  },
  en: {
    ...sessionStorageTranslations.en,
    ...browserInterventionTranslations.en,
    ...skillWorkshopTranslations.en,
    ...browserRecordingTranslations.en,
    ...getHomeGreetingTranslations('en'),
    ...appTranslations.en,
    ...settingsTranslations.en,
    ...chatTranslations.en,
    ...pluginsTranslations.en,
    ...scheduledTaskTranslations.en,
  },
};
