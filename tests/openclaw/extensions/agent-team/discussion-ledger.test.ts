import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DiscussionLedger } from '../../../../plugins/extensions/runtime-services/agent-team/discussion/discussion-ledger';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('consumes admission across restarts and preserves exact native run identities', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-ledger-'));
  roots.push(root);
  const first = new DiscussionLedger(root);
  const executions = [
    {
      discussionId: 'discussion',
      agentId: 'alice',
      sessionKey: 'agent:alice:justdo-team:group:room',
      sessionId: 'physical-session',
      lifecycleRevision: 'revision',
      runId: 'native-run',
    },
  ];
  first.write({
    roomId: 'room',
    discussionId: 'discussion',
    fingerprint: 'sha256-only',
    owner: first.owner,
    state: 'running',
    executions,
  });
  expect(first.read('discussion')?.state).toBe('running');
  const restarted = new DiscussionLedger(root);
  expect(restarted.read('discussion')).toMatchObject({
    state: 'unknown',
    fingerprint: 'sha256-only',
    executions,
  });
  expect(readdirSync(root)).toEqual(['discussion.json']);
  expect(readFileSync(path.join(root, 'discussion.json'), 'utf8')).not.toMatch(
    /message|prompt|content/,
  );
});
it('rejects path traversal in receipt identities', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-ledger-'));
  roots.push(root);
  expect(() => new DiscussionLedger(root).read('../escape')).toThrow('teamDiscussionInvalidInput');
});

it('keeps room deletion closed across native service restarts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-ledger-'));
  roots.push(root);
  const ledger = new DiscussionLedger(root);
  ledger.closeRoom('deleted-room');
  expect(new DiscussionLedger(root).isRoomClosed('deleted-room')).toBe(true);
});

it('does not invent a terminal for an explicitly uncertain execution after restarting', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-ledger-'));
  roots.push(root);
  const ledger = new DiscussionLedger(root);
  ledger.write({
    roomId: 'room',
    discussionId: 'uncertain',
    fingerprint: 'sha256',
    owner: ledger.owner,
    state: 'unknown',
    executions: [
      {
        discussionId: 'uncertain',
        agentId: 'alice',
        sessionKey: 'agent:alice:justdo-team:group:room',
        sessionId: 'physical',
        lifecycleRevision: 'rev',
        runId: 'native',
        outcome: 'running',
      },
    ],
  });
  expect(new DiscussionLedger(root).read('uncertain')).toMatchObject({
    state: 'unknown',
    executions: [{ outcome: 'running' }],
  });
});

it('rejects terminal states without whole-run and cleanup evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-ledger-'));
  roots.push(root);
  const ledger = new DiscussionLedger(root);
  const executions = [
    {
      discussionId: 'uncertain',
      agentId: 'alice',
      sessionKey: 'agent:alice:justdo-team:group:room',
      sessionId: 'physical',
      lifecycleRevision: 'rev',
      runId: 'native',
      outcome: 'failed' as const,
    },
  ];
  ledger.write({
    roomId: 'room',
    discussionId: 'uncertain',
    fingerprint: 'sha256',
    owner: ledger.owner,
    state: 'failed',
    executions,
  });
  expect(new DiscussionLedger(root).read('uncertain')).toMatchObject({
    state: 'unknown',
    executions,
  });
  ledger.write({
    roomId: 'room',
    discussionId: 'uncertain',
    fingerprint: 'sha256',
    owner: ledger.owner,
    state: 'failed',
    executions,
    cleanupComplete: true,
    settledRunIds: ['native'],
  });
  expect(new DiscussionLedger(root).read('uncertain')?.state).toBe('failed');
});
