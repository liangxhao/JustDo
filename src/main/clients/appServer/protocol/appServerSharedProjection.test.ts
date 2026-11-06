import { expect, test } from 'vitest';

import { projectCodexHistory } from './appServerHistory';
import { paginateThreads } from './appServerPagination';
import type { AppServerThreadMetadata } from './appServerTypes';
import { codexThread, codexThreadOpen } from './appServerWire';

const metadata = (id: string, source: string): AppServerThreadMetadata => ({
  id, source, cwd: process.cwd(), modelRef: 'provider/model', name: 'A thread',
  createdAt: 1000, updatedAt: 2000, status: 'completed', permissionMode: 'ask',
});

test('standard source values preserve the same required thread and configuration fields', () => {
  const primary = metadata('00000000-0000-4000-8000-000000000001', 'cli');
  const secondary = metadata('00000000-0000-4000-8000-000000000002', 'appServer');
  const primaryThread = codexThread(primary);
  const secondaryThread = codexThread(secondary);
  expect(Object.keys(secondaryThread).sort()).toEqual(Object.keys(primaryThread).sort());
  expect(secondaryThread).toMatchObject({ source: 'appServer', path: null, turns: [] });
  expect(codexThreadOpen(secondary, secondary)).toMatchObject({ model: 'provider/model',
    sandbox: { type: 'externalSandbox' }, approvalsReviewer: 'user' });
});

test('thread filters and pagination cursors retain the authenticated source boundary', () => {
  const primary = [metadata('00000000-0000-4000-8000-000000000001', 'cli'),
    metadata('00000000-0000-4000-8000-000000000002', 'cli')];
  const secondary = primary.map(thread => ({ ...thread, source: 'appServer' }));
  const params = { limit: 1, sourceKinds: ['appServer'] };
  expect(paginateThreads(primary, params).data).toEqual([]);
  const page = paginateThreads(secondary, params);
  expect(page.data).toHaveLength(1);
  expect(() => paginateThreads(primary, { ...params, cursor: page.nextCursor })).toThrow('pagination cursor');
});

test('unverified generic timing cannot turn visible historical text into a completed execution', () => {
  const snapshot = projectCodexHistory({ threadId: 'thread', unknownRunIds: ['logical'],
    runs: [{ id: 'receipt', sessionId: 'product', clientTurnId: 'logical', rootRunId: 'actual',
      startedAt: 1000, endedAt: 2000, state: 'completed' }],
    messages: [{ role: 'assistant', content: 'Visible reply', __openclaw: { id: 'message', runId: 'actual' } }],
  });
  expect(snapshot.turns[0]).toMatchObject({ id: 'logical', status: 'failed', completedAt: null,
    error: { message: expect.stringContaining('EXECUTION_UNKNOWN:') } });
});

test('a logical admission ID never substitutes for a different known native root', () => {
  const snapshot = projectCodexHistory({ threadId: 'thread',
    runs: [{ id: 'receipt', sessionId: 'product', clientTurnId: 'logical', rootRunId: 'actual',
      startedAt: 1000, endedAt: 2000, state: 'completed' }],
    messages: [{ role: 'assistant', content: 'Unattributed reply', __openclaw: { id: 'message', runId: 'logical' } }],
  });
  expect(snapshot.turns[0].id).toMatch(/^history:/);
  expect(snapshot.turns[0]).toMatchObject({ status: 'failed', completedAt: null });
});
