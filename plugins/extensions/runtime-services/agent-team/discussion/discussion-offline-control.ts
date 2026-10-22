import path from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { isTeamDiscussionId, TeamDiscussionGateway } from '../contracts/discussion';
import { DiscussionLedger } from './discussion-ledger';

/** Reconcile exact execution receipts and close admission after Agent Team is disabled. */
export function registerDiscussionOfflineControl(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    TeamDiscussionGateway.OfflineControl,
    ({ params, respond }) => {
      try {
        if (api.runtime.config.current().plugins?.entries?.['agent-team']?.enabled === true)
          throw new Error('teamDiscussionBusy');
        if (!isTeamDiscussionId(params.roomId)) throw new Error('teamDiscussionInvalidInput');
        if (params.operation === 'summary-status' || params.operation === 'summary-stop') {
          if (!isTeamDiscussionId(params.discussionId))
            throw new Error('teamDiscussionInvalidInput');
          const summaries = new DiscussionLedger(
            path.join(api.runtime.state.resolveStateDir(), 'agent-team', 'summary-receipts'),
            true,
          );
          let receipt = summaries.read(params.discussionId);
          if (receipt && receipt.roomId !== params.roomId)
            throw new Error('teamDiscussionInvalidInput');
          if (params.operation === 'summary-stop' && !receipt) {
            receipt = {
              roomId: params.roomId,
              discussionId: params.discussionId,
              fingerprint: 'cancelled-before-admission',
              owner: summaries.owner,
              state: 'cancelled',
              executions: [],
            };
            summaries.write(receipt);
          }
          respond(true, {
            state:
              !receipt || receipt.interrupted
                ? 'unknown'
                : receipt.state === 'completed'
                  ? 'delivered'
                  : receipt.state,
            runId: receipt?.executions[0]?.runId,
          });
          return;
        }
        const ledger = new DiscussionLedger(
          path.join(api.runtime.state.resolveStateDir(), 'agent-team', 'discussion-receipts'),
        );
        if (params.operation === 'close') {
          ledger.closeRoom(params.roomId);
          respond(true, { closed: true });
          return;
        }
        if (
          !['status', 'stop'].includes(String(params.operation)) ||
          !isTeamDiscussionId(params.discussionId)
        )
          throw new Error('teamDiscussionInvalidInput');
        let receipt = ledger.read(params.discussionId);
        if (receipt && receipt.roomId !== params.roomId)
          throw new Error('teamDiscussionInvalidInput');
        if (!receipt && params.operation === 'stop') {
          receipt = {
            roomId: params.roomId,
            discussionId: params.discussionId,
            fingerprint: 'cancelled-before-admission',
            owner: ledger.owner,
            state: 'cancelled',
            executions: [],
          };
          ledger.write(receipt);
        }
        respond(
          true,
          receipt
            ? {
                roomId: receipt.roomId,
                discussionId: receipt.discussionId,
                state: receipt.state,
                executions: receipt.executions,
              }
            : { state: 'unknown' },
        );
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionUnavailable',
        });
      }
    },
    { scope: 'operator.admin' },
  );
}
