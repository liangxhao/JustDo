import { useSyncExternalStore } from 'react';

import OperationResultModal from './OperationResultModal';
import { pluginOperationFailurePresentation } from './pluginOperationPresentation';
import { getPluginOperationOwner } from './pluginOperationService';

const PluginOperationFeedback = () => {
  const owner = getPluginOperationOwner();
  const failures = useSyncExternalStore(owner.subscribeFailures, owner.failureSnapshot);
  const failure = failures[0];
  const title = failure ? pluginOperationFailurePresentation(failure).title : '';

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
