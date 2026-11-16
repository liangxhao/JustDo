import { SubagentReadFailure } from '@shared/cowork/subagentDetails';

import { i18nService } from '@/services/i18n';

const messages = {
  [SubagentReadFailure.Disconnected]: 'subtaskReadDisconnected',
  [SubagentReadFailure.TimedOut]: 'subtaskReadTimedOut',
  [SubagentReadFailure.CatalogUpdating]: 'subtaskReadCatalogUpdating',
  [SubagentReadFailure.InvalidData]: 'subtaskReadInvalidData',
  [SubagentReadFailure.SessionUnavailable]: 'subtaskReadSessionUnavailable',
  [SubagentReadFailure.PermissionDenied]: 'subtaskReadPermissionDenied',
  [SubagentReadFailure.PageExpired]: 'subtaskReadPageExpired',
  [SubagentReadFailure.EngineRejected]: 'subtaskReadEngineRejected',
  [SubagentReadFailure.Unexpected]: 'subtaskReadUnexpected',
} as const satisfies Record<SubagentReadFailure, string>;

export function subagentReadMessage(reason: SubagentReadFailure = SubagentReadFailure.Unexpected) {
  return i18nService.t(messages[reason]);
}
