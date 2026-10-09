import { browserInterventionTranslations } from '@/features/browser/intervention/browserInterventionTranslations';
import { browserRecordingTranslations } from '@/features/browser/recording/browserRecordingTranslations';
import type { LanguageType } from '@/services/i18n';

import { appTranslations } from './appTranslations';
import { authTranslations } from './authTranslations';
import { chatTranslations } from './chatTranslations';
import { getHomeGreetingTranslations } from './homeGreetings';
import { initializationTranslations } from './initializationTranslations';
import { pluginsTranslations } from './pluginsTranslations';
import { scheduledTaskTranslations } from './scheduledTaskTranslations';
import { sessionDiagnosticsTranslations } from './sessionDiagnosticsTranslations';
import { sessionReviewTranslations } from './sessionReviewTranslations';
import { sessionStorageTranslations } from './sessionStorageTranslations';
import { settingsTranslations } from './settingsTranslations';
import { skillWorkshopTranslations } from './skillWorkshopTranslations';
import { swarmTranslations } from './swarmTranslations';
import { swarmWorkflowTranslations } from './swarmWorkflowTranslations';

export const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    ...initializationTranslations.zh,
    ...authTranslations.zh,
    ...swarmTranslations.zh,
    ...swarmWorkflowTranslations.zh,
    ...sessionDiagnosticsTranslations.zh,
    ...sessionReviewTranslations.zh,
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
    ...initializationTranslations.en,
    ...authTranslations.en,
    ...swarmTranslations.en,
    ...swarmWorkflowTranslations.en,
    ...sessionDiagnosticsTranslations.en,
    ...sessionReviewTranslations.en,
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
