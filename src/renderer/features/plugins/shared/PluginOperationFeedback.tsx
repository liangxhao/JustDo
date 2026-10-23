import { useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';

import OperationResultModal from './OperationResultModal';
import { getPluginOperationOwner } from './pluginOperationService';

const PluginOperationFeedback = () => {
  const owner = getPluginOperationOwner();
  const failures = useSyncExternalStore(owner.subscribeFailures, owner.failureSnapshot);
  const failure = failures[0];
  const title = failure
    ? i18nService.t(
        failure.state === 'failed'
          ? `pluginOperationFailureTitle.${failure.action}`
          : `pluginOperationFailureTitle.${failure.state}`,
      )
    : '';

  return (
    <OperationResultModal
      result={failure ? { type: 'error', title, items: failure.items } : null}
      operation={failure}
      onClose={() => {
        if (failure) owner.dismissFailure(failure.requestId);
      }}
    />
  );
};

export default PluginOperationFeedback;
