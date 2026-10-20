import type { AppHistoryPresentation } from '@app-plugin/sdk/history-presentation';

import { stripSwarmWorkflowInstruction } from '../prompt/request';
import { swarmWorkflowTranslations } from './history/translations';

export const presentation: AppHistoryPresentation = {
  text: stripSwarmWorkflowInstruction,
  translations: swarmWorkflowTranslations,
};
