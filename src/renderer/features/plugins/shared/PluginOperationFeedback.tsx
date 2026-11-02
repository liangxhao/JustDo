import { useEffect, useSyncExternalStore } from 'react';

import {
  getEngineReadinessSnapshot,
  refreshEngineReadiness,
  useEngineReadiness,
} from '@/app/shell/startup/routing/useEngineReadiness';

import OperationResultModal, { OperationResultNotice } from './OperationResultModal';
import {
  pluginOperationFailurePresentation,
  pluginOperationHasPendingRecovery,
} from './pluginOperationPresentation';
import { getPluginOperationOwner } from './pluginOperationService';

const PluginOperationFeedback = () => {
  const engine = useEngineReadiness();
  const owner = getPluginOperationOwner();
  const failures = useSyncExternalStore(owner.subscribeFailures, owner.failureSnapshot);
  const pendingRecoveries = failures.filter(pluginOperationHasPendingRecovery);
  const failure = failures.find(operation => !pluginOperationHasPendingRecovery(operation));
  const title = failure ? pluginOperationFailurePresentation(failure).title : '';

  useEffect(() => {
    const requestIds = failures
      .filter(
        operation => pluginOperationHasPendingRecovery(operation) && !operation.runtimeRecovered,
      )
      .map(operation => operation.requestId);
    if (!requestIds.length) return;
    let live = true;
    // Re-read admission after the result arrives; a cached Running/ready snapshot
    // can still belong to the lifecycle that preceded this recovery observation.
    void refreshEngineReadiness()
      .then(ready => {
        if (live && ready && getEngineReadinessSnapshot().ready)
          owner.confirmRuntimeRecovery(requestIds);
      })
      .catch(() => {
        // A failed read keeps the original report; it cannot change a mutation receipt.
      });
    return () => {
      live = false;
    };
  }, [engine.ready, failures, owner]);

  return (
    <>
      {pendingRecoveries.map(operation => (
        <OperationResultNotice
          key={operation.requestId}
          result={{ type: 'success', title: pluginOperationFailurePresentation(operation).title }}
          operation={operation}
          runtimeRecovered={operation.runtimeRecovered}
          onClose={() => owner.dismissFailure(operation.requestId)}
        />
      ))}
      <OperationResultModal
        result={failure ? { type: 'error', title, items: failure.items } : null}
        operation={failure}
        onClose={() => {
          if (failure) owner.dismissFailure(failure.requestId);
        }}
      />
    </>
  );
};

export default PluginOperationFeedback;
