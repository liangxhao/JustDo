import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  type CollaborationReview,
  CollaborationReviewState,
  parseCollaborationReview,
} from '../../../shared/cowork/agent-team/collaboration';

export function initializeCollaborationReviewTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_reviews (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL,
      reviewer_agent_id TEXT NOT NULL,
      review_delivery_id TEXT NOT NULL REFERENCES collaboration_deliveries(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('passed','changes_requested','unverified')),
      created_at INTEGER NOT NULL,
      FOREIGN KEY(round_id, room_id) REFERENCES collaboration_rounds(id, room_id) ON DELETE CASCADE,
      UNIQUE(room_id, reviewer_agent_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_reviews_round ON collaboration_reviews(room_id, round_id, created_at);
    CREATE TABLE IF NOT EXISTS collaboration_review_deliveries (
      review_id TEXT NOT NULL REFERENCES collaboration_reviews(id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL REFERENCES collaboration_deliveries(id) ON DELETE CASCADE,
      PRIMARY KEY(review_id, delivery_id)
    );
  `);
}

type ReviewRow = Omit<CollaborationReview, 'deliveryIds' | 'state'> & {
  stoppedAt: number | null;
  outcome: string | null;
  admission: string;
};

/** Immutable, exact-run review reports; never a task scheduler or transcript store. */
export class CollaborationReviewStore {
  constructor(private readonly db: Database.Database) {}

  report(roomId: string, sessionKey: string, runId: string, value: unknown): CollaborationReview {
    const input = parseCollaborationReview(value);
    return this.db.transaction(() => {
      const context = this.db
        .prepare(
          `
        SELECT m.agent_id AS reviewer, r.anchor_session_id AS anchor,
          m.session_id AS sessionId, owner.agent_id AS organizer,
          d.id AS deliveryId, d.round_id AS roundId
        FROM collaboration_members m
        JOIN collaboration_rooms r ON r.id = m.room_id
        JOIN collaboration_members owner ON owner.session_id = r.anchor_session_id
        JOIN collaboration_deliveries d ON d.room_id = r.id AND d.target_agent_id = m.agent_id
          AND d.source_agent_id = owner.agent_id AND d.run_id = ?
        JOIN collaboration_rounds batch ON batch.id = d.round_id
        WHERE r.id = ? AND m.session_key = ? AND d.state IN ('dispatching','accepted')
          AND batch.stopped_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM collaboration_deletions WHERE room_id = r.id)
        ORDER BY d.created_at, d.id LIMIT 1
      `,
        )
        .get(runId, roomId, sessionKey) as
        | {
            reviewer: string;
            anchor: string;
            sessionId: string;
            organizer: string;
            deliveryId: string;
            roundId: string;
          }
        | undefined;
      if (!context || context.sessionId === context.anchor)
        throw new Error('collaborationInvalidReview');
      for (const id of input.deliveryIds) {
        const receipt = this.db
          .prepare(
            `
          SELECT d.target_agent_id AS agentId, e.outcome
          FROM collaboration_deliveries d
          JOIN collaboration_members m ON m.room_id = d.room_id AND m.agent_id = d.target_agent_id
          JOIN collaboration_execution_receipts e ON e.room_id = d.room_id
            AND e.session_key = m.session_key AND e.run_id = d.run_id
          WHERE d.id = ? AND d.room_id = ? AND d.round_id = ? AND d.state = 'accepted'
        `,
          )
          .get(id, roomId, context.roundId) as { agentId: string; outcome: string } | undefined;
        // A reviewer cannot certify its own run, the organizer's run, or incomplete work.
        if (
          !receipt ||
          receipt.outcome !== 'completed' ||
          receipt.agentId === context.reviewer ||
          receipt.agentId === context.organizer
        )
          throw new Error('collaborationInvalidReview');
      }
      const id = createHash('sha256')
        .update(JSON.stringify([roomId, sessionKey, runId]))
        .digest('hex');
      const previous = this.list(roomId).find(review => review.id === id);
      if (previous) {
        if (
          previous.verdict !== input.verdict ||
          JSON.stringify(previous.deliveryIds) !== JSON.stringify(input.deliveryIds)
        )
          throw new Error('collaborationReviewConflict');
        return previous;
      }
      this.db
        .prepare(
          `INSERT INTO collaboration_reviews
        (id,room_id,round_id,reviewer_agent_id,review_delivery_id,run_id,verdict,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          roomId,
          context.roundId,
          context.reviewer,
          context.deliveryId,
          runId,
          input.verdict,
          Date.now(),
        );
      const link = this.db.prepare('INSERT INTO collaboration_review_deliveries VALUES (?,?)');
      for (const deliveryId of input.deliveryIds) link.run(id, deliveryId);
      return this.list(roomId).find(review => review.id === id)!;
    })();
  }

  list(roomId: string): CollaborationReview[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.room_id AS roomId, r.round_id AS roundId,
      r.reviewer_agent_id AS reviewerAgentId, r.review_delivery_id AS reviewDeliveryId,
      r.run_id AS runId, r.verdict, r.created_at AS createdAt,
      batch.stopped_at AS stoppedAt, e.outcome, d.state AS admission
      FROM collaboration_reviews r
      JOIN collaboration_members m ON m.room_id = r.room_id AND m.agent_id = r.reviewer_agent_id
      JOIN collaboration_rounds batch ON batch.id = r.round_id
      JOIN collaboration_deliveries d ON d.id = r.review_delivery_id
      LEFT JOIN collaboration_execution_receipts e ON e.room_id = r.room_id
        AND e.session_key = m.session_key AND e.run_id = r.run_id
      WHERE r.room_id = ? ORDER BY r.created_at, r.id`,
      )
      .all(roomId) as ReviewRow[];
    return rows.map(({ stoppedAt, outcome, admission, ...review }) => ({
      ...review,
      deliveryIds: (
        this.db
          .prepare(
            `SELECT delivery_id AS id FROM collaboration_review_deliveries
        WHERE review_id = ? ORDER BY delivery_id`,
          )
          .all(review.id) as { id: string }[]
      ).map(item => item.id),
      state:
        stoppedAt !== null || outcome === 'cancelled'
          ? CollaborationReviewState.CANCELLED
          : outcome === 'failed' || admission === 'failed'
            ? CollaborationReviewState.FAILED
            : outcome === 'completed' && admission === 'accepted'
              ? CollaborationReviewState.CONFIRMED
              : admission === 'unknown'
                ? CollaborationReviewState.UNCONFIRMED
                : CollaborationReviewState.PENDING,
    }));
  }
}
