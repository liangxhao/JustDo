import { createCustodyClient } from '@runtime-services/sdk/custody-client';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import type { DiscussionReceipt } from './ledger';
import { discussionOperationId } from './receipt';

export function discussionReceiptWriter(api: OpenClawPluginApi, kind: 'discussion' | 'summary') {
  const custody = createCustodyClient(api);
  return (receipt: DiscussionReceipt) => {
    if (!/^[a-f0-9]{64}$/u.test(receipt.fingerprint)) {
      if (receipt.executions.length) throw new Error('teamDiscussionExecutionConflict');
      return;
    }
    custody.writeExecutionReceipt({
      operationId: discussionOperationId(kind, receipt.discussionId), inputSha256: receipt.fingerprint,
      subjects: receipt.executions.map(({ agentId, sessionKey, sessionId, lifecycleRevision, runId }) => ({ agentId, sessionKey, sessionId, lifecycleRevision, runId })),
      cleanupComplete: receipt.cleanupComplete === true,
    });
  };
}
