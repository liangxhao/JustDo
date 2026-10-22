import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { DiscussionResources } from '../../contracts/agentTeamSettings';
import {
  assertTeamDiscussionRecipients,
  serializeTeamDiscussionSend,
  TEAM_DISCUSSION_MAX_PENDING_INPUTS,
  type TeamDiscussionHoldingIdentity,
  type TeamDiscussionPendingInput,
  type TeamDiscussionPendingState,
  type TeamDiscussionRoom,
  type TeamDiscussionSend,
} from '../../contracts/teamDiscussion';

const activeSql = "'receiving','receiving_unknown','queued','dispatching','unknown','blocked'";
export function initializeTeamDiscussionQueueTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_discussion_queue_control (
      room_id TEXT PRIMARY KEY REFERENCES team_discussion_rooms(id),
      generation INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS team_discussion_pending_inputs (
      room_id TEXT NOT NULL REFERENCES team_discussion_rooms(id),
      request_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      native_fingerprint TEXT,
      attachment_fingerprint TEXT,
      snapshot_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      rounds INTEGER NOT NULL,
      recipients_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (${activeSql},'dispatched','cancelled','failed')),
      identity_json TEXT,
      entry_id TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(room_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_pending_fifo ON team_discussion_pending_inputs(room_id,state,created_at);
  `);
}
interface PendingRow {
  room_id: string;
  request_id: string;
  generation: number;
  fingerprint: string;
  snapshot_hash: string;
  revision: number;
  rounds: number;
  recipients_json: string;
  native_fingerprint: string | null;
  attachment_fingerprint: string | null;
  resources_json: string;
  state: TeamDiscussionPendingState;
  identity_json: string | null;
  entry_id: string | null;
  reason: string | null;
  created_at: number;
}
export interface PendingInputRecord extends TeamDiscussionPendingInput {
  roomId: string;
  generation: number;
  fingerprint: string;
  nativeFingerprint?: string;
  attachmentFingerprint?: string;
  snapshotHash: string;
  expectedRevision: number;
  resources: DiscussionResources;
  identity?: TeamDiscussionHoldingIdentity;
  entryId?: string;
}
function project(row: PendingRow): PendingInputRecord {
  return {
    roomId: row.room_id,
    requestId: row.request_id,
    generation: row.generation,
    fingerprint: row.fingerprint,
    snapshotHash: row.snapshot_hash,
    expectedRevision: row.revision,
    ...(row.native_fingerprint ? { nativeFingerprint: row.native_fingerprint } : {}),
    ...(row.attachment_fingerprint ? { attachmentFingerprint: row.attachment_fingerprint } : {}),
    rounds: row.rounds,
    selectedAgentIds: JSON.parse(row.recipients_json),
    resources: JSON.parse(row.resources_json),
    state: row.state,
    createdAt: row.created_at,
    ...(row.identity_json ? { identity: JSON.parse(row.identity_json) } : {}),
    ...(row.entry_id ? { entryId: row.entry_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}
export const pendingInputFingerprint = (send: TeamDiscussionSend): string =>
  createHash('sha256').update(serializeTeamDiscussionSend(send)).digest('hex');

/** Durable receipts only: no prompt, filenames, attachment body or transcript cache. */
export class TeamDiscussionQueueStore {
  constructor(private readonly db: Database.Database) {}
  get(roomId: string, requestId: string): PendingInputRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM team_discussion_pending_inputs WHERE room_id = ? AND request_id = ?')
      .get(roomId, requestId) as PendingRow | undefined;
    return row && project(row);
  }
  list(roomId: string, activeOnly = false): PendingInputRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM team_discussion_pending_inputs WHERE room_id = ? ${activeOnly ? `AND state IN (${activeSql})` : ''} ORDER BY created_at,rowid`,
        )
        .all(roomId) as PendingRow[]
    ).map(project);
  }
  projection(roomId: string): TeamDiscussionPendingInput[] {
    // Include recent terminal receipts so a lost UI acknowledgement can be reconciled.
    const records = this.list(roomId);
    return [
      ...records.filter(item => this.isActive(item)),
      ...records.filter(item => !this.isActive(item)).slice(-16),
    ].map(({ requestId, state, createdAt, rounds, selectedAgentIds, reason }) => ({
      requestId,
      state,
      createdAt,
      rounds,
      selectedAgentIds,
      ...(reason ? { reason } : {}),
    }));
  }
  isActive(input: TeamDiscussionPendingInput): boolean {
    return [
      'receiving',
      'receiving_unknown',
      'queued',
      'dispatching',
      'unknown',
      'blocked',
    ].includes(input.state);
  }
  hasActive(roomId: string): boolean {
    return this.list(roomId, true).length > 0;
  }
  generation(roomId: string): number {
    return (
      (
        this.db
          .prepare('SELECT generation FROM team_discussion_queue_control WHERE room_id = ?')
          .get(roomId) as { generation: number } | undefined
      )?.generation ?? 1
    );
  }
  reserve(
    room: TeamDiscussionRoom,
    send: TeamDiscussionSend,
    snapshotHash: string,
    resources: DiscussionResources,
  ): PendingInputRecord {
    const fingerprint = pendingInputFingerprint(send);
    return this.db.transaction(() => {
      const prior = this.get(room.id, send.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('teamDiscussionRequestConflict');
        return prior;
      }
      const current = this.db
        .prepare('SELECT revision,state FROM team_discussion_rooms WHERE id = ?')
        .get(room.id) as { revision: number; state: string } | undefined;
      if (!current) throw new Error('teamDiscussionNotFound');
      assertTeamDiscussionRecipients({ ...room, revision: current.revision }, send);
      if (!['ready', 'running', 'submitting'].includes(current.state))
        throw new Error('teamDiscussionBusy');
      if (
        this.db
          .prepare(
            "SELECT 1 FROM team_discussion_summaries WHERE room_id = ? AND state IN ('unknown','stopping') LIMIT 1",
          )
          .get(room.id)
      )
        throw new Error('teamDiscussionOutcomeUnknown');
      if (
        this.list(room.id, true).some(item =>
          ['receiving_unknown', 'unknown', 'blocked'].includes(item.state),
        )
      )
        throw new Error('teamDiscussionOutcomeUnknown');
      if (this.list(room.id, true).length >= TEAM_DISCUSSION_MAX_PENDING_INPUTS)
        throw new Error('teamDiscussionQueueFull');
      this.db
        .prepare('INSERT OR IGNORE INTO team_discussion_queue_control(room_id) VALUES (?)')
        .run(room.id);
      this.db
        .prepare(
          `INSERT INTO team_discussion_pending_inputs
        (room_id,request_id,generation,fingerprint,snapshot_hash,revision,rounds,recipients_json,resources_json,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'receiving',?)`,
        )
        .run(
          room.id,
          send.requestId,
          this.generation(room.id),
          fingerprint,
          snapshotHash,
          send.expectedRevision,
          send.rounds,
          JSON.stringify(send.selectedAgentIds),
          JSON.stringify(resources),
          Date.now(),
        );
      return this.get(room.id, send.requestId)!;
    })();
  }
  setIdentity(
    input: PendingInputRecord,
    identity: TeamDiscussionHoldingIdentity,
    nativeFingerprint: string,
    attachmentFingerprint: string,
  ): boolean {
    if (identity.roomId !== input.roomId || identity.generation !== input.generation)
      throw new Error('teamDiscussionSessionChanged');
    return (
      this.db
        .prepare(
          `UPDATE team_discussion_pending_inputs SET identity_json = ?,native_fingerprint = ?,attachment_fingerprint = ?
      WHERE room_id = ? AND request_id = ? AND generation = ? AND state = 'receiving'
      AND generation = (SELECT generation FROM team_discussion_queue_control WHERE room_id = ?)`,
        )
        .run(
          JSON.stringify(identity),
          nativeFingerprint,
          attachmentFingerprint,
          input.roomId,
          input.requestId,
          input.generation,
          input.roomId,
        ).changes === 1
    );
  }
  confirm(input: PendingInputRecord, entryId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE team_discussion_pending_inputs SET state = 'queued',entry_id = ?,reason = NULL
      WHERE room_id = ? AND request_id = ? AND generation = ? AND identity_json IS NOT NULL
      AND state IN ('receiving','receiving_unknown')
      AND generation = (SELECT generation FROM team_discussion_queue_control WHERE room_id = ?)`,
        )
        .run(entryId, input.roomId, input.requestId, input.generation, input.roomId).changes === 1
    );
  }
  transition(
    input: PendingInputRecord,
    from: TeamDiscussionPendingState[],
    state: TeamDiscussionPendingState,
    reason?: string,
  ): boolean {
    if (reason && !/^teamDiscussion[A-Za-z]+$/.test(reason))
      throw new Error('teamDiscussionInvalidInput');
    return (
      this.db
        .prepare(
          `UPDATE team_discussion_pending_inputs SET state = ?,reason = ?
      WHERE room_id = ? AND request_id = ? AND generation = ? AND state IN (${from.map(() => '?').join(',')})`,
        )
        .run(state, reason ?? null, input.roomId, input.requestId, input.generation, ...from)
        .changes === 1
    );
  }
  claim(input: PendingInputRecord): boolean {
    return this.db.transaction(() => {
      const head = this.list(input.roomId, true)[0];
      if (
        head?.requestId !== input.requestId ||
        head.state !== 'queued' ||
        this.generation(input.roomId) !== input.generation
      )
        return false;
      const room = this.db
        .prepare('SELECT state,active_discussion_id FROM team_discussion_rooms WHERE id = ?')
        .get(input.roomId) as { state: string; active_discussion_id: string | null } | undefined;
      const summary = this.db
        .prepare(
          "SELECT 1 FROM team_discussion_summaries WHERE room_id = ? AND state IN ('pending','running','stopping','unknown') LIMIT 1",
        )
        .get(input.roomId);
      if (!room || room.state !== 'ready' || room.active_discussion_id || summary) return false;
      return this.transition(input, ['queued'], 'dispatching');
    })();
  }
  cancel(roomId: string, requestId: string): PendingInputRecord {
    return this.db.transaction(() => {
      const input = this.get(roomId, requestId);
      if (!input) throw new Error('teamDiscussionNotFound');
      if (['dispatching', 'unknown'].includes(input.state)) throw new Error('teamDiscussionBusy');
      this.transition(input, ['receiving', 'receiving_unknown', 'queued', 'blocked'], 'cancelled');
      return this.get(roomId, requestId)!;
    })();
  }
  cancelAll(roomId: string): number {
    return this.db.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO team_discussion_queue_control(room_id) VALUES (?)')
        .run(roomId);
      this.db
        .prepare(
          'UPDATE team_discussion_queue_control SET generation = generation + 1 WHERE room_id = ?',
        )
        .run(roomId);
      this.db
        .prepare(
          "UPDATE team_discussion_pending_inputs SET state = 'cancelled' WHERE room_id = ? AND state IN ('receiving','receiving_unknown','queued','blocked')",
        )
        .run(roomId);
      this.db
        .prepare(
          "UPDATE team_discussion_pending_inputs SET state = 'unknown' WHERE room_id = ? AND state = 'dispatching'",
        )
        .run(roomId);
      return this.generation(roomId);
    })();
  }
  recover(): void {
    this.db
      .prepare(
        "UPDATE team_discussion_pending_inputs SET state = CASE WHEN state = 'receiving' THEN 'receiving_unknown' ELSE 'unknown' END WHERE state IN ('receiving','dispatching')",
      )
      .run();
  }
  remove(roomId: string): void {
    this.db.prepare('DELETE FROM team_discussion_pending_inputs WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM team_discussion_queue_control WHERE room_id = ?').run(roomId);
  }
}
