import { browserInterventionTranslations } from '@/features/browser/intervention/browserInterventionTranslations';
import { browserRecordingTranslations } from '@/features/browser/recording/browserRecordingTranslations';
import type { LanguageType } from '@/services/i18n';

import { askUserQuestionTranslations } from '../../../../plugins/extensions/ask-user-question/browser/translations';
import { appPluginTranslations } from '../../../shared/plugins/app/appPluginTranslations';
import { appTranslations } from './appTranslations.mts';
import { assistantTranslations } from './assistantTranslations';
import { authTranslations } from './authTranslations';
import { browserTranslations } from './browserTranslations';
import { chatTranslations } from './chatTranslations';
import { filePreviewTranslations } from './filePreviewTranslations';
import { getHomeGreetingTranslations } from './homeGreetings';
import { initializationTranslations } from './initializationTranslations.mts';
import { mcpAppsTranslations } from './mcpAppsTranslations';
import { memoryTranslations } from './memoryTranslations';
import { pluginsTranslations } from './pluginsTranslations';
import { scheduledTaskTranslations } from './scheduledTaskTranslations';
import { sessionDiagnosticsTranslations } from './sessionDiagnosticsTranslations';
import { sessionReviewTranslations } from './sessionReviewTranslations';
import { sessionStorageTranslations } from './sessionStorageTranslations';
import { settingsTranslations } from './settingsTranslations';
import { skillWorkshopTranslations } from './skillWorkshopTranslations';
import { startupTranslations } from './startupTranslations.mts';
import { swarmTranslations } from './swarmTranslations';
import { terminalTranslations } from './terminalTranslations';
import { workboardTranslations } from './workboardTranslations';
import { workspaceDisplayTranslations } from './workspaceDisplayTranslations';

export const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    ...askUserQuestionTranslations.zh,
    ...appPluginTranslations.zh,
    ...appTranslations.zh,
    ...assistantTranslations.zh,
    ...authTranslations.zh,
    ...browserTranslations.zh,
    ...browserInterventionTranslations.zh,
    ...browserRecordingTranslations.zh,
    ...chatTranslations.zh,
    ...filePreviewTranslations.zh,
    ...getHomeGreetingTranslations('zh'),
    ...initializationTranslations.zh,
    ...startupTranslations.zh,
    ...memoryTranslations.zh,
    ...mcpAppsTranslations.zh,
    ...pluginsTranslations.zh,
    ...scheduledTaskTranslations.zh,
    ...sessionDiagnosticsTranslations.zh,
    ...sessionReviewTranslations.zh,
    ...sessionStorageTranslations.zh,
    ...settingsTranslations.zh,
    ...skillWorkshopTranslations.zh,
    ...swarmTranslations.zh,
    ...terminalTranslations.zh,
    ...workboardTranslations.zh,
    ...workspaceDisplayTranslations.zh,
  },
  en: {
    ...askUserQuestionTranslations.en,
    ...appPluginTranslations.en,
    ...appTranslations.en,
    ...assistantTranslations.en,
    ...authTranslations.en,
    ...browserTranslations.en,
    ...browserInterventionTranslations.en,
    ...browserRecordingTranslations.en,
    ...chatTranslations.en,
    ...filePreviewTranslations.en,
    ...getHomeGreetingTranslations('en'),
    ...initializationTranslations.en,
    ...startupTranslations.en,
    ...memoryTranslations.en,
    ...mcpAppsTranslations.en,
    ...pluginsTranslations.en,
    ...scheduledTaskTranslations.en,
    ...sessionDiagnosticsTranslations.en,
    ...sessionReviewTranslations.en,
    ...sessionStorageTranslations.en,
    ...settingsTranslations.en,
    ...skillWorkshopTranslations.en,
    ...swarmTranslations.en,
    ...terminalTranslations.en,
    ...workboardTranslations.en,
    ...workspaceDisplayTranslations.en,
  },
};
