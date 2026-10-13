import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { registerDiscussionOfflineControl } from '../../../../openclaw-extensions/runtime-services/agent-team/discussion/discussion-offline-control';
import { DiscussionLedger } from '../../../../openclaw-extensions/runtime-services/agent-team/discussion/discussion-ledger';
import { TeamDiscussionGateway } from '../../../../src/shared/cowork/agent-team/teamDiscussion';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-offline-control-'));
  roots.push(root);
  let handle:
    | ((input: { params: Record<string, unknown>; respond: ReturnType<typeof vi.fn> }) => void)
    | undefined;
  registerDiscussionOfflineControl({
    runtime: { config: { current: () => ({}) }, state: { resolveStateDir: () => root } },
    registerGatewayMethod: (name: string, handler: typeof handle) => {
      expect(name).toBe(TeamDiscussionGateway.OfflineControl);
      if (name === TeamDiscussionGateway.OfflineControl) handle = handler;
    },
  } as never);
  const ledger = new DiscussionLedger(path.join(root, 'agent-team', 'summary-receipts'), true);
  return {
    ledger,
    request(operation: string) {
      const respond = vi.fn();
      handle!({ params: { roomId: 'room', discussionId: 'batch', operation }, respond });
      return respond.mock.lastCall;
    },
  };
}

it('does not turn a stopped previous owner into cancellation evidence when the extension is disabled', () => {
  const test = harness();
  test.ledger.write({
    roomId: 'room',
    discussionId: 'batch',
    fingerprint: 'fingerprint',
    owner: test.ledger.owner,
    state: 'running',
    executions: [
      {
        discussionId: 'batch',
        agentId: 'organizer',
        sessionKey: 'agent:organizer:justdo:source',
        sessionId: 'native-source',
        lifecycleRevision: 'revision',
        runId: 'accepted-run',
        outcome: 'running',
      },
    ],
  });
  expect(test.request('summary-stop')).toEqual([true, { state: 'unknown', runId: 'accepted-run' }]);
  expect(test.ledger.read('batch')).toMatchObject({
    state: 'unknown',
    executions: [{ runId: 'accepted-run', outcome: 'running' }],
  });
  expect(test.request('summary-status')).toEqual([
    true,
    { state: 'unknown', runId: 'accepted-run' },
  ]);
});

it('only writes a cancelled-before-admission tombstone when there is no native receipt', () => {
  const test = harness();
  expect(test.request('summary-stop')).toEqual([true, { state: 'cancelled', runId: undefined }]);
  expect(test.ledger.read('batch')).toMatchObject({
    state: 'cancelled',
    fingerprint: 'cancelled-before-admission',
    executions: [],
  });
});
