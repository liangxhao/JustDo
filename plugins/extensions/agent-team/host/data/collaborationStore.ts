import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  canTransitionCollaborationDelivery,
  type CollaborationDelivery,
  CollaborationDeliveryState,
  type CollaborationMember,
  type CollaborationRoom,
  type CollaborationRoomEntry,
  type CollaborationRound,
  parseCollaborationSend,
  resolveCollaborationRoute,
  validateCollaborationRoom,
} from '../../contracts/collaboration';
import { AgentTeamSettingsService } from './agentTeamSettingsService';
import {
  CollaborationReviewStore,
  initializeCollaborationReviewTables,
} from './collaborationReviewStore';

export function initializeCollaborationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_rooms (
      id TEXT PRIMARY KEY,
      anchor_session_id TEXT NOT NULL UNIQUE REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      settings_json TEXT
    );
    CREATE TABLE IF NOT EXISTS collaboration_members (
      room_id TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      session_id TEXT NOT NULL UNIQUE REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      session_key TEXT NOT NULL UNIQUE,
      PRIMARY KEY(room_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_deletions (
      room_id TEXT PRIMARY KEY REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_deleted_members (
      room_id TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      PRIMARY KEY(room_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_rounds (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      stopped_at INTEGER,
      closing_run_id TEXT,
      message_budget INTEGER NOT NULL DEFAULT 16,
      UNIQUE(id, room_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_deliveries (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      in_reply_to TEXT REFERENCES collaboration_deliveries(id),
      state TEXT NOT NULL CHECK(state IN ('queued', 'dispatching', 'accepted', 'unknown', 'failed')),
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(round_id, room_id) REFERENCES collaboration_rounds(id, room_id) ON DELETE CASCADE,
      UNIQUE(room_id, source_agent_id, source_run_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_deliveries_round ON collaboration_deliveries(round_id);
    CREATE INDEX IF NOT EXISTS idx_collaboration_deliveries_room ON collaboration_deliveries(room_id, created_at, id);
    CREATE TABLE IF NOT EXISTS collaboration_execution_receipts (
      room_id TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
      session_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','cancelled')),
      PRIMARY KEY(room_id, session_key, run_id)
    );
  `);
  initializeCollaborationReviewTables(db);
}

const DELIVERY_COLUMNS = `id, room_id AS roomId, round_id AS roundId,
  source_agent_id AS "from", target_agent_id AS "to", tool_call_id AS toolCallId, source_run_id AS sourceRunId,
  in_reply_to AS inReplyTo, state, run_id AS runId, created_at AS createdAt, updated_at AS updatedAt`;

type DeliveryRow = Omit<CollaborationDelivery, 'inReplyTo' | 'runId'> & {
  inReplyTo: string | null;
  runId: string | null;
};
const toDelivery = ({ inReplyTo, runId, ...delivery }: DeliveryRow): CollaborationDelivery => ({
  ...delivery,
  ...(inReplyTo ? { inReplyTo } : {}),
  ...(runId ? { runId } : {}),
});

/** Durable routing metadata, never a second message transcript. */
export class CollaborationStore {
  readonly reviews: CollaborationReviewStore;
  constructor(private readonly db: Database.Database) {
    this.reviews = new CollaborationReviewStore(db);
  }

  recordExecution(
    sessionKey: string,
    runId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): void {
    const member = this.db
      .prepare('SELECT room_id FROM collaboration_members WHERE session_key = ?')
      .get(sessionKey) as { room_id: string } | undefined;
    if (!member || !runId || runId.length > 256) return;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO collaboration_execution_receipts(room_id,session_key,run_id,outcome) VALUES (?,?,?,?)',
      )
      .run(member.room_id, sessionKey, runId, outcome);
  }

  /** Sealing prevents new peer sends; it does not cancel accepted work. */
  sealRound(roomId: string, roundId: string, closingRunId: string): void {
    this.db.transaction(() => {
      if (!closingRunId || this.isRoundStopped(roundId))
        throw new Error('collaborationInvalidRound');
      const row = this.db
        .prepare('SELECT closing_run_id FROM collaboration_rounds WHERE id = ? AND room_id = ?')
        .get(roundId, roomId) as { closing_run_id: string | null } | undefined;
      if (!row || (row.closing_run_id && row.closing_run_id !== closingRunId))
        throw new Error('collaborationInvalidRound');
      this.db
        .prepare('UPDATE collaboration_rounds SET closing_run_id = ? WHERE id = ? AND room_id = ?')
        .run(closingRunId, roundId, roomId);
    })();
  }

  rounds(roomId: string): CollaborationRound[] {
    const room = this.getRoom(roomId);
    const source = room?.members.find(member => member.sessionId === room.anchorSessionId);
    const deliveries = this.listDeliveries(roomId);
    const rows = this.db
      .prepare(
        'SELECT id, stopped_at, closing_run_id FROM collaboration_rounds WHERE room_id = ? ORDER BY created_at, rowid',
      )
      .all(roomId) as Array<{
      id: string;
      stopped_at: number | null;
      closing_run_id: string | null;
    }>;
    return rows.map(row => {
      const batch = deliveries.filter(item => item.roundId === row.id);
      const pending = batch.filter(
        item => item.state !== 'failed' && !item.executionOutcome,
      ).length;
      const closing =
        source && row.closing_run_id
          ? (this.db
              .prepare(
                'SELECT outcome FROM collaboration_execution_receipts WHERE room_id = ? AND session_key = ? AND run_id = ?',
              )
              .get(roomId, source.sessionKey, row.closing_run_id) as
              { outcome: string } | undefined)
          : undefined;
      return {
        id: row.id,
        pending,
        ...(row.closing_run_id ? { closingRunId: row.closing_run_id } : {}),
        state:
          row.stopped_at !== null
            ? 'stopped'
            : !row.closing_run_id
              ? 'open'
              : pending || !closing
                ? 'closing'
                : closing.outcome !== 'completed' ||
                    batch.some(
                      item =>
                        item.state === 'failed' ||
                        (item.executionOutcome && item.executionOutcome !== 'completed'),
                    )
                  ? 'failed'
                  : 'settled',
      };
    });
  }

  beginDeletion(roomId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO collaboration_deletions(room_id, started_at) VALUES (?, ?)')
      .run(roomId, Date.now());
  }

  isDeleting(roomId: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM collaboration_deletions WHERE room_id = ?').get(roomId),
    );
  }

  markMemberDeleted(roomId: string, sessionId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO collaboration_deleted_members(room_id, session_id) VALUES (?, ?)',
      )
      .run(roomId, sessionId);
  }

  isMemberDeleted(roomId: string, sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM collaboration_deleted_members WHERE room_id = ? AND session_id = ?')
        .get(roomId, sessionId),
    );
  }

  expireNativeAdmissions(): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE collaboration_deliveries SET state = 'unknown', updated_at = ? WHERE state = 'dispatching' AND run_id IS NULL AND updated_at < ?",
      )
      .run(now, now - 60000);
  }

  createRoom(room: CollaborationRoom, runningAnchor = false): CollaborationRoom {
    validateCollaborationRoom(room);
    return this.db.transaction(() => {
      if (
        room.members.length >
        new AgentTeamSettingsService(this.db).read().value.collaboration.maxMembers
      )
        throw new Error('agentTeamSettingsMembersExceeded');
      for (const member of room.members) {
        const session = this.db
          .prepare(
            `SELECT s.agent_id, s.status, a.enabled FROM cowork_sessions s
          JOIN agents a ON a.id = s.agent_id WHERE s.id = ?`,
          )
          .get(member.sessionId) as
          { agent_id: string; status: string; enabled: number } | undefined;
        if (
          !session ||
          session.agent_id !== member.agentId ||
          !session.enabled ||
          (session.status === 'running' &&
            !(runningAnchor && member.sessionId === room.anchorSessionId))
        ) {
          throw new Error('collaborationInvalidMembers');
        }
      }
      this.db
        .prepare('INSERT INTO collaboration_rooms (id, anchor_session_id) VALUES (?, ?)')
        .run(room.id, room.anchorSessionId);
      const insert = this.db.prepare(`INSERT INTO collaboration_members
        (room_id, agent_id, session_id, session_key) VALUES (?, ?, ?, ?)`);
      for (const member of room.members)
        insert.run(room.id, member.agentId, member.sessionId, member.sessionKey);
      return this.getRoom(room.id)!;
    })();
  }

  addMember(roomId: string, member: CollaborationMember): void {
    this.db.transaction(() => {
      const room = this.getRoom(roomId);
      if (!room) throw new Error('collaborationInvalidMembers');
      validateCollaborationRoom({ ...room, members: [...room.members, member] });
      if (
        room.members.length >=
        new AgentTeamSettingsService(this.db).read().value.collaboration.maxMembers
      )
        throw new Error('agentTeamSettingsMembersExceeded');
      const session = this.db
        .prepare(
          `SELECT s.agent_id, a.enabled FROM cowork_sessions s
        JOIN agents a ON a.id = s.agent_id WHERE s.id = ?`,
        )
        .get(member.sessionId) as { agent_id: string; enabled: number } | undefined;
      if (!session?.enabled || session.agent_id !== member.agentId)
        throw new Error('collaborationInvalidMembers');
      this.db
        .prepare(
          `INSERT INTO collaboration_members
        (room_id, agent_id, session_id, session_key) VALUES (?, ?, ?, ?)`,
        )
        .run(roomId, member.agentId, member.sessionId, member.sessionKey);
    })();
  }

  listRooms(): CollaborationRoom[] {
    const rows = this.db.prepare('SELECT id FROM collaboration_rooms').all() as { id: string }[];
    return rows.map(row => this.getRoom(row.id)!);
  }

  listRoomEntries(): CollaborationRoomEntry[] {
    return this.listRooms().map(room => {
      const dispatchedRounds = new Set(
        this.listDeliveries(room.id).map(delivery => delivery.roundId),
      );
      return {
        ...room,
        rounds: this.rounds(room.id).filter(
          round => dispatchedRounds.has(round.id) || round.closingRunId,
        ),
      };
    });
  }

  getRoom(id: string): CollaborationRoom | undefined {
    const room = this.db
      .prepare(
        'SELECT id, anchor_session_id AS anchorSessionId FROM collaboration_rooms WHERE id = ?',
      )
      .get(id) as Omit<CollaborationRoom, 'members'> | undefined;
    if (!room) return undefined;
    const members = this.db
      .prepare(
        `SELECT agent_id AS agentId, session_id AS sessionId, session_key AS sessionKey
      FROM collaboration_members WHERE room_id = ? ORDER BY agent_id`,
      )
      .all(id) as CollaborationMember[];
    return { ...room, members, ...(this.isDeleting(room.id) ? { deleting: true } : {}) };
  }

  getRoomForSession(sessionId: string): CollaborationRoom | undefined {
    const row = this.db
      .prepare('SELECT room_id FROM collaboration_members WHERE session_id = ?')
      .get(sessionId) as { room_id: string } | undefined;
    return row ? this.getRoom(row.room_id) : undefined;
  }

  stopRounds(roomId: string): void {
    this.db.transaction(() => {
      const stop = this.db.prepare(
        'UPDATE collaboration_rounds SET stopped_at = ? WHERE room_id = ? AND id = ? AND stopped_at IS NULL',
      );
      const stoppedAt = Date.now();
      // Stopping current work must not rewrite settled history or invalidate its review reports.
      for (const round of this.rounds(roomId)) {
        if (round.state === 'open' || round.state === 'closing')
          stop.run(stoppedAt, roomId, round.id);
      }
    })();
  }

  isRoundStopped(roundId: string): boolean {
    const row = this.db
      .prepare('SELECT stopped_at FROM collaboration_rounds WHERE id = ?')
      .get(roundId) as { stopped_at: number | null } | undefined;
    return !row || row.stopped_at !== null;
  }

  beginRound(roomId: string, userTurnId: string): void {
    if (!userTurnId || userTurnId.length > 128 || !this.getRoom(roomId))
      throw new Error('collaborationInvalidRound');
    const existing = this.db
      .prepare('SELECT room_id FROM collaboration_rounds WHERE id = ?')
      .get(userTurnId) as { room_id: string } | undefined;
    if (existing) {
      if (existing.room_id !== roomId) throw new Error('collaborationInvalidRound');
      return;
    }
    const settings = new AgentTeamSettingsService(this.db).readTeam('collaboration', roomId);
    const budget = Math.min(
      settings.global.value.collaboration.messageBudget,
      settings.team.value.messageBudget ?? 16,
    );
    this.db
      .prepare(
        'INSERT INTO collaboration_rounds (id, room_id, created_at, message_budget) VALUES (?, ?, ?, ?)',
      )
      .run(userTurnId, roomId, Date.now(), budget);
  }

  getDelivery(id: string): CollaborationDelivery | undefined {
    const row = this.db
      .prepare(`SELECT ${DELIVERY_COLUMNS} FROM collaboration_deliveries WHERE id = ?`)
      .get(id) as DeliveryRow | undefined;
    return row ? toDelivery(row) : undefined;
  }

  listDeliveries(roomId: string): CollaborationDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT ${DELIVERY_COLUMNS} FROM collaboration_deliveries
      WHERE room_id = ? ORDER BY created_at, id`,
      )
      .all(roomId) as DeliveryRow[];
    const members = this.getRoom(roomId)?.members ?? [];
    return rows.map(row => {
      const delivery = toDelivery(row);
      const key = members.find(member => member.agentId === delivery.to)?.sessionKey;
      const receipt =
        key && delivery.runId
          ? (this.db
              .prepare(
                'SELECT outcome FROM collaboration_execution_receipts WHERE room_id = ? AND session_key = ? AND run_id = ?',
              )
              .get(roomId, key, delivery.runId) as
              { outcome: CollaborationDelivery['executionOutcome'] } | undefined)
          : undefined;
      return { ...delivery, ...(receipt ? { executionOutcome: receipt.outcome } : {}) };
    });
  }

  /** sourceSessionKey, sourceRunId and toolCallId must come from trusted runtime context, never tool arguments. */
  enqueue(
    roomId: string,
    roundId: string,
    sourceSessionKey: string,
    toolCallId: string,
    sourceRunId: string,
    raw: unknown,
  ): CollaborationDelivery {
    const input = parseCollaborationSend(raw);
    if (!toolCallId || toolCallId.length > 256 || !sourceRunId || sourceRunId.length > 256)
      throw new Error('collaborationInvalidMessage');
    return this.db.transaction(() => {
      const room = this.getRoom(roomId);
      if (!room) throw new Error('collaborationInvalidMembers');
      const { source, target } = resolveCollaborationRoute(
        room,
        sourceSessionKey,
        input,
        input.inReplyTo ? this.getDelivery(input.inReplyTo) : undefined,
      );
      for (const member of [source, target]) {
        const agent = this.db
          .prepare('SELECT enabled FROM agents WHERE id = ?')
          .get(member.agentId) as { enabled: number } | undefined;
        if (!agent?.enabled) throw new Error('collaborationInvalidMembers');
      }
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const existing = this.db
        .prepare(
          `SELECT id, input_digest, round_id FROM collaboration_deliveries
        WHERE room_id = ? AND source_agent_id = ? AND source_run_id = ? AND tool_call_id = ?`,
        )
        .get(roomId, source.agentId, sourceRunId, toolCallId) as
        { id: string; input_digest: string; round_id: string } | undefined;
      if (existing) {
        if (existing.input_digest !== digest || existing.round_id !== roundId)
          throw new Error('collaborationDuplicateConflict');
        return this.getDelivery(existing.id)!;
      }
      if (
        room.members.length >
        new AgentTeamSettingsService(this.db).read().value.collaboration.maxMembers
      )
        throw new Error('agentTeamSettingsMembersExceeded');
      const round = this.db
        .prepare(
          'SELECT room_id, closing_run_id, message_budget FROM collaboration_rounds WHERE id = ?',
        )
        .get(roundId) as
        { room_id: string; closing_run_id: string | null; message_budget: number } | undefined;
      if (round?.room_id !== roomId || round.closing_run_id || this.isRoundStopped(roundId))
        throw new Error('collaborationInvalidRound');
      const count = this.db
        .prepare('SELECT COUNT(*) AS count FROM collaboration_deliveries WHERE round_id = ?')
        .get(roundId) as { count: number };
      if (count.count >= round.message_budget) throw new Error('collaborationBudgetExceeded');
      const id = randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO collaboration_deliveries
        (id, room_id, round_id, source_agent_id, target_agent_id, tool_call_id, source_run_id, input_digest,
          in_reply_to, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          roomId,
          roundId,
          source.agentId,
          target.agentId,
          toolCallId,
          sourceRunId,
          digest,
          input.inReplyTo ?? null,
          CollaborationDeliveryState.QUEUED,
          now,
          now,
        );
      return this.getDelivery(id)!;
    })();
  }

  transition(
    id: string,
    expected: CollaborationDeliveryState,
    next: CollaborationDeliveryState,
    runId?: string,
  ): CollaborationDelivery {
    if (
      !canTransitionCollaborationDelivery(expected, next) ||
      (next === CollaborationDeliveryState.ACCEPTED && (!runId?.trim() || runId.length > 256))
    ) {
      throw new Error('collaborationInvalidTransition');
    }
    const result = this.db
      .prepare(
        `UPDATE collaboration_deliveries SET state = ?, run_id = COALESCE(?, run_id),
      updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = ?`,
      )
      .run(next, runId ?? null, Date.now(), id, expected);
    if (result.changes !== 1) throw new Error('collaborationStateConflict');
    return this.getDelivery(id)!;
  }

  /** On application restart, do not resend calls whose native admission is uncertain. */
  recoverInterrupted(): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE collaboration_deliveries SET state = 'unknown', updated_at = MAX(updated_at + 1, ?) WHERE state = 'dispatching'",
        )
        .run(Date.now());
      // Bodies are native-owned and absent here. Replaying a queue requires explicit native recovery.
      this.db
        .prepare(
          "UPDATE collaboration_deliveries SET state = 'failed', updated_at = MAX(updated_at + 1, ?) WHERE state = 'queued'",
        )
        .run(Date.now());
    })();
  }
}
