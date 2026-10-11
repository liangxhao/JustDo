import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { CollaborationStore, initializeCollaborationTables } from './collaborationStore';

let db: Database.Database;
let store: CollaborationStore;
const key = (agent: string) => `agent:${agent}:justdo:${agent}`;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY, enabled INTEGER);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT);
    INSERT INTO agents VALUES('main',1),('worker',1),('reviewer',1);
    INSERT INTO cowork_sessions VALUES('main','main','idle'),('worker','worker','idle'),('reviewer','reviewer','idle');`);
  initializeCollaborationTables(db);
  store = new CollaborationStore(db);
  store.createRoom({
    id: 'room',
    anchorSessionId: 'main',
    members: ['main', 'worker', 'reviewer'].map(agentId => ({
      agentId,
      sessionId: agentId,
      sessionKey: key(agentId),
    })),
  });
  store.beginRound('room', 'batch');
});
afterEach(() => db.close());
const admit = (agent: string, runId: string, batch = 'batch') => {
  const delivery = store.enqueue('room', batch, key('main'), runId, 'main-run', {
    to: agent,
    message: 'Native task context',
  });
  store.transition(delivery.id, 'queued', 'dispatching');
  store.transition(delivery.id, 'dispatching', 'accepted', runId);
  return delivery.id;
};
const ready = () => {
  const worker = admit('worker', 'worker-run');
  const reviewer = admit('reviewer', 'review-run');
  store.recordExecution(key('worker'), 'worker-run', 'completed');
  return { worker, reviewer };
};

it('keeps a passed report pending until its exact whole reviewer run ends', () => {
  const { worker } = ready();
  const report = store.reviews.report('room', key('reviewer'), 'review-run', {
    deliveryIds: [worker],
    verdict: 'passed',
  });
  expect(report).toMatchObject({ state: 'pending', verdict: 'passed', deliveryIds: [worker] });
  store.recordExecution(key('reviewer'), 'different-run', 'completed');
  expect(store.reviews.list('room')[0].state).toBe('pending');
  store.recordExecution(key('reviewer'), 'review-run', 'completed');
  expect(store.reviews.list('room')[0].state).toBe('confirmed');
  expect(
    db
      .prepare('PRAGMA table_info(collaboration_reviews)')
      .all()
      .map((item: unknown) => (item as { name: string }).name),
  ).not.toEqual(expect.arrayContaining(['message', 'findings', 'evidence', 'criteria']));
});

it('replays an identical report but rejects changed scope or verdict in the same run', () => {
  const { worker } = ready();
  const input = { deliveryIds: [worker], verdict: 'unverified' };
  const first = store.reviews.report('room', key('reviewer'), 'review-run', input);
  expect(store.reviews.report('room', key('reviewer'), 'review-run', input).id).toBe(first.id);
  expect(() =>
    store.reviews.report('room', key('reviewer'), 'review-run', { ...input, verdict: 'passed' }),
  ).toThrow('collaborationReviewConflict');
  expect(store.reviews.list('room')).toHaveLength(1);
});

it('preserves exact scope across reinitialization and does not certify later work', () => {
  const { worker } = ready();
  store.reviews.report('room', key('reviewer'), 'review-run', {
    deliveryIds: [worker],
    verdict: 'passed',
  });
  store.recordExecution(key('reviewer'), 'review-run', 'completed');
  initializeCollaborationTables(db);
  const reopened = new CollaborationStore(db);
  expect(reopened.reviews.list('room')[0]).toMatchObject({
    state: 'confirmed',
    deliveryIds: [worker],
  });
  const later = admit('worker', 'new-work-run');
  store.recordExecution(key('worker'), 'new-work-run', 'completed');
  expect(reopened.reviews.list('room')[0].deliveryIds).not.toContain(later);
  const nextReviewer = admit('reviewer', 'new-review-run');
  expect(reopened.reviews.list('room')[0].reviewDeliveryId).not.toBe(nextReviewer);
});

it('waits for accepted admission even if the reviewer terminal arrives first', () => {
  const { worker, reviewer } = ready();
  db.prepare("UPDATE collaboration_deliveries SET state='dispatching' WHERE id=?").run(reviewer);
  store.recordExecution(key('reviewer'), 'review-run', 'completed');
  const report = store.reviews.report('room', key('reviewer'), 'review-run', {
    deliveryIds: [worker],
    verdict: 'passed',
  });
  expect(report.state).toBe('pending');
  db.prepare("UPDATE collaboration_deliveries SET state='unknown' WHERE id=?").run(reviewer);
  expect(store.reviews.list('room')[0].state).toBe('unconfirmed');
  store.transition(reviewer, 'unknown', 'accepted', 'review-run');
  expect(store.reviews.list('room')[0].state).toBe('confirmed');
});

it('rejects self-review, unadmitted identities and unfinished or cross-batch work', () => {
  const { worker, reviewer } = ready();
  const report = (session: string, run: string, delivery: string) =>
    store.reviews.report('room', key(session), run, { deliveryIds: [delivery], verdict: 'passed' });
  expect(() => report('worker', 'worker-run', worker)).toThrow('collaborationInvalidReview');
  expect(() => report('main', 'main-run', worker)).toThrow('collaborationInvalidReview');
  expect(() => report('reviewer', 'wrong-run', worker)).toThrow('collaborationInvalidReview');
  expect(() => report('reviewer', 'review-run', reviewer)).toThrow('collaborationInvalidReview');
  const unfinished = admit('worker', 'unfinished-run');
  expect(() => report('reviewer', 'review-run', unfinished)).toThrow('collaborationInvalidReview');
  store.beginRound('room', 'other');
  const other = admit('worker', 'other-run', 'other');
  store.recordExecution(key('worker'), 'other-run', 'completed');
  expect(() => report('reviewer', 'review-run', other)).toThrow('collaborationInvalidReview');
});

it('never confirms a verdict when the reviewer fails or the batch is stopped', () => {
  const { worker } = ready();
  store.reviews.report('room', key('reviewer'), 'review-run', {
    deliveryIds: [worker],
    verdict: 'passed',
  });
  store.recordExecution(key('reviewer'), 'review-run', 'failed');
  expect(store.reviews.list('room')[0]).toMatchObject({ state: 'failed', verdict: 'passed' });
  store.stopRounds('room');
  expect(store.reviews.list('room')[0].state).toBe('cancelled');
  expect(() =>
    store.reviews.report('room', key('reviewer'), 'review-run', {
      deliveryIds: [worker],
      verdict: 'passed',
    }),
  ).toThrow('collaborationInvalidReview');
});

it('rejects reports during deletion and cascades metadata with the room', () => {
  const { worker } = ready();
  store.reviews.report('room', key('reviewer'), 'review-run', {
    deliveryIds: [worker],
    verdict: 'changes_requested',
  });
  store.beginDeletion('room');
  expect(() =>
    store.reviews.report('room', key('reviewer'), 'review-run', {
      deliveryIds: [worker],
      verdict: 'changes_requested',
    }),
  ).toThrow('collaborationInvalidReview');
  db.prepare('DELETE FROM collaboration_rooms WHERE id = ?').run('room');
  expect(db.prepare('SELECT * FROM collaboration_reviews').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM collaboration_review_deliveries').all()).toEqual([]);
});
