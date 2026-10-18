import { browserInterventionTranslations } from '@/features/browser/intervention/browserInterventionTranslations';
import { browserRecordingTranslations } from '@/features/browser/recording/browserRecordingTranslations';
import type { LanguageType } from '@/services/i18n';

import { appTranslations } from './appTranslations';
import { assistantTranslations } from './assistantTranslations';
import { authTranslations } from './authTranslations';
import { browserTranslations } from './browserTranslations';
import { chatTranslations } from './chatTranslations';
import { collaborationTranslations } from './collaborationTranslations';
import { filePreviewTranslations } from './filePreviewTranslations';
import { getHomeGreetingTranslations } from './homeGreetings';
import { initializationTranslations } from './initializationTranslations';
import { mcpAppsTranslations } from './mcpAppsTranslations';
import { memoryTranslations } from './memoryTranslations';
import { pluginsTranslations } from './pluginsTranslations';
import { scheduledTaskTranslations } from './scheduledTaskTranslations';
import { sessionDiagnosticsTranslations } from './sessionDiagnosticsTranslations';
import { sessionReviewTranslations } from './sessionReviewTranslations';
import { sessionStorageTranslations } from './sessionStorageTranslations';
import { settingsTranslations } from './settingsTranslations';
import { skillWorkshopTranslations } from './skillWorkshopTranslations';
import { swarmTranslations } from './swarmTranslations';
import { swarmWorkflowTranslations } from './swarmWorkflowTranslations';
import { teamDiscussionTranslations } from './teamDiscussionTranslations';
import { terminalTranslations } from './terminalTranslations';
import { workboardTranslations } from './workboardTranslations';
import { workspaceDisplayTranslations } from './workspaceDisplayTranslations';

export const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    ...appTranslations.zh,
    ...assistantTranslations.zh,
    ...authTranslations.zh,
    ...browserTranslations.zh,
    ...browserInterventionTranslations.zh,
    ...browserRecordingTranslations.zh,
    ...chatTranslations.zh,
    ...collaborationTranslations.zh,
    ...filePreviewTranslations.zh,
    ...getHomeGreetingTranslations('zh'),
    ...initializationTranslations.zh,
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
    ...swarmWorkflowTranslations.zh,
    ...teamDiscussionTranslations.zh,
    ...terminalTranslations.zh,
    ...workboardTranslations.zh,
    ...workspaceDisplayTranslations.zh,
  },
  en: {
    ...appTranslations.en,
    ...assistantTranslations.en,
    ...authTranslations.en,
    ...browserTranslations.en,
    ...browserInterventionTranslations.en,
    ...browserRecordingTranslations.en,
    ...chatTranslations.en,
    ...collaborationTranslations.en,
    ...filePreviewTranslations.en,
    ...getHomeGreetingTranslations('en'),
    ...initializationTranslations.en,
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
    ...swarmWorkflowTranslations.en,
    ...teamDiscussionTranslations.en,
    ...terminalTranslations.en,
    ...workboardTranslations.en,
    ...workspaceDisplayTranslations.en,
  },
};
