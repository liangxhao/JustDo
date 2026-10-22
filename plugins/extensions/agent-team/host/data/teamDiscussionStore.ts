import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  type DiscussionResources,
  parseDiscussionResources,
} from '../../contracts/agentTeamSettings';
import {
  assertTeamDiscussionRecipients,
  parseTeamDiscussionSend,
  type TeamDiscussionExecution,
  type TeamDiscussionRoom,
  TeamDiscussionState,
  type TeamDiscussionSummary,
} from '../../contracts/teamDiscussion';
import {
  initializeTeamDiscussionQueueTables,
  TeamDiscussionQueueStore,
} from './teamDiscussionQueueStore';

/** Metadata only. Native OpenClaw transcripts remain the sole message store. */
export function initializeTeamDiscussionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_discussion_deleted_rooms (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_discussion_rooms (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      members_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      permission_mode TEXT NOT NULL CHECK(permission_mode IN ('ask','auto','full')),
      read_only INTEGER NOT NULL DEFAULT 1 CHECK(read_only IN (0,1)),
      rounds INTEGER NOT NULL CHECK(rounds BETWEEN 1 AND 4),
      revision INTEGER NOT NULL DEFAULT 1,
      generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK(state IN ('preparing','prepare_failed','ready','submitting','running','stopping','interrupted','deleting')),
      active_discussion_id TEXT,
      source_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_discussion_runs (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES team_discussion_rooms(id),
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      initiator_agent_id TEXT,
      revision INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('submitting','running','stopping','interrupted','completed','failed','cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(room_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_discussion_active
      ON team_discussion_runs(room_id)
      WHERE state IN ('submitting','running','stopping','interrupted');
    CREATE INDEX IF NOT EXISTS idx_team_discussion_runs_room
      ON team_discussion_runs(room_id, created_at, id);
    CREATE TABLE IF NOT EXISTS team_discussion_task_links (
      room_id TEXT NOT NULL REFERENCES team_discussion_rooms(id),
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY(room_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS team_discussion_executions (
      discussion_id TEXT NOT NULL REFERENCES team_discussion_runs(id),
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      lifecycle_revision TEXT NOT NULL,
      run_id TEXT NOT NULL,
      outcome TEXT,
      PRIMARY KEY(discussion_id, run_id)
    );
  `);
  const columns = db.prepare('PRAGMA table_info(team_discussion_runs)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'initiator_agent_id'))
    db.exec('ALTER TABLE team_discussion_runs ADD COLUMN initiator_agent_id TEXT');
  if (!columns.some(column => column.name === 'summary_suppressed'))
    db.exec(
      'ALTER TABLE team_discussion_runs ADD COLUMN summary_suppressed INTEGER NOT NULL DEFAULT 0',
    );
  const roomColumns = db.prepare('PRAGMA table_info(team_discussion_rooms)').all() as {
    name: string;
  }[];
  if (!columns.some(column => column.name === 'requested_rounds'))
    db.exec('ALTER TABLE team_discussion_runs ADD COLUMN requested_rounds INTEGER');
  if (!columns.some(column => column.name === 'resources_json'))
    db.exec('ALTER TABLE team_discussion_runs ADD COLUMN resources_json TEXT');
  if (!roomColumns.some(column => column.name === 'settings_json'))
    db.exec('ALTER TABLE team_discussion_rooms ADD COLUMN settings_json TEXT');
  if (!roomColumns.some(column => column.name === 'summary_source_json'))
    db.exec('ALTER TABLE team_discussion_rooms ADD COLUMN summary_source_json TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS team_discussion_summaries (
    discussion_id TEXT PRIMARY KEY REFERENCES team_discussion_runs(id),
    room_id TEXT NOT NULL REFERENCES team_discussion_rooms(id),
    state TEXT NOT NULL CHECK(state IN ('pending','running','stopping','delivered','failed','cancelled','unknown')),
    run_id TEXT,
    updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_team_summary_pending ON team_discussion_summaries(state, updated_at);
  CREATE INDEX IF NOT EXISTS idx_team_summary_room_state ON team_discussion_summaries(room_id, state);`);
  initializeTeamDiscussionQueueTables(db);
}

interface RunRow {
  id: string;
  room_id: string;
  request_id: string;
  fingerprint: string;
  revision: number;
  generation: number;
  state: string;
}
interface RoomRow {
  id: string;
  title: string;
  members_json: string;
  cwd: string;
  permission_mode: TeamDiscussionRoom['permissionMode'];
  read_only: number;
  rounds: number;
  revision: number;
  generation: number;
  state: TeamDiscussionState;
  active_discussion_id: string | null;
  source_session_id: string | null;
  summary_source_json: string | null;
  created_at: number;
  updated_at: number;
}
function projectRoom(row: RoomRow): TeamDiscussionRoom {
  return {
    id: row.id,
    title: row.title,
    members: JSON.parse(row.members_json),
    readOnly: row.read_only === 1,
    rounds: row.rounds,
    revision: row.revision,
    generation: row.generation,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cwd: row.cwd,
    permissionMode: row.permission_mode,
    ...(row.active_discussion_id ? { activeDiscussionId: row.active_discussion_id } : {}),
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.summary_source_json ? { summarySource: JSON.parse(row.summary_source_json) } : {}),
  };
}

export class TeamDiscussionStore {
  get queue(): TeamDiscussionQueueStore {
    return new TeamDiscussionQueueStore(this.db);
  }
  constructor(private readonly db: Database.Database) {}

  get(id: string): TeamDiscussionRoom | undefined {
    const row = this.db.prepare('SELECT * FROM team_discussion_rooms WHERE id = ?').get(id) as
      RoomRow | undefined;
    return row
      ? {
          ...projectRoom(row),
          latestRun: this.latestRun(row.id),
          pendingInputs: this.queue.projection(row.id),
          linkedTaskIds: (
            this.db
              .prepare(
                'SELECT session_id FROM team_discussion_task_links WHERE room_id = ? ORDER BY rowid',
              )
              .all(id) as { session_id: string }[]
          ).map(link => link.session_id),
        }
      : undefined;
  }
  list(): TeamDiscussionRoom[] {
    return (
      this.db
        .prepare('SELECT * FROM team_discussion_rooms ORDER BY updated_at DESC, id')
        .all() as RoomRow[]
    ).map(row => ({
      ...projectRoom(row),
      latestRun: this.latestRun(row.id),
      pendingInputs: this.queue.projection(row.id),
    }));
  }
  summary(discussionId: string): TeamDiscussionSummary | undefined {
    return this.db
      .prepare(
        'SELECT discussion_id AS discussionId, state, run_id AS runId FROM team_discussion_summaries WHERE discussion_id = ?',
      )
      .get(discussionId) as TeamDiscussionSummary | undefined;
  }
  pendingSummaries(): {
    roomId: string;
    discussionId: string;
    state: TeamDiscussionSummary['state'];
  }[] {
    return this.db
      .prepare(
        "SELECT room_id AS roomId, discussion_id AS discussionId, state FROM team_discussion_summaries WHERE state IN ('pending','running','stopping','unknown') ORDER BY updated_at LIMIT 16",
      )
      .all() as { roomId: string; discussionId: string; state: TeamDiscussionSummary['state'] }[];
  }
  /** Admission guards query the whole room, independently of the bounded worker batch. */
  hasUnsettledSummary(roomId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM team_discussion_summaries WHERE room_id = ? AND state IN ('pending','running','stopping','unknown') LIMIT 1",
      )
      .get(roomId);
  }
  assertSettled(roomId: string): void {
    const room = this.get(roomId);
    if (!room || room.activeDiscussionId || this.hasUnsettledSummary(roomId))
      throw new Error('teamDiscussionBusy');
  }
  recordSummaryAttempt(discussionId: string): void {
    // Advance failed polls too, so a bounded batch cannot starve newer summaries.
    // Never replace state: cancellation or completion may have won while awaiting native I/O.
    this.db
      .prepare(
        "UPDATE team_discussion_summaries SET updated_at = MAX(updated_at + 1, ?) WHERE discussion_id = ? AND state IN ('pending','running','stopping','unknown')",
      )
      .run(Date.now(), discussionId);
  }
  updateSummary(discussionId: string, state: TeamDiscussionSummary['state'], runId?: string): void {
    this.db
      .prepare(
        "UPDATE team_discussion_summaries SET state = ?, run_id = COALESCE(?, run_id), updated_at = ? WHERE discussion_id = ? AND (state IN ('pending','running','unknown') OR (state = 'stopping' AND ? IN ('cancelled','delivered','failed')))",
      )
      .run(state, runId ?? null, Date.now(), discussionId, state);
  }
  cancelSummaries(roomId: string): string[] {
    const pending = this.db
      .prepare(
        "SELECT discussion_id FROM team_discussion_summaries WHERE room_id = ? AND state IN ('pending','running','stopping','unknown')",
      )
      .all(roomId) as { discussion_id: string }[];
    this.db
      .prepare(
        "UPDATE team_discussion_summaries SET state = 'stopping', updated_at = ? WHERE room_id = ? AND state IN ('pending','running','unknown')",
      )
      .run(Date.now(), roomId);
    return pending.map(row => row.discussion_id);
  }
  create(room: TeamDiscussionRoom): void {
    if (this.db.prepare('SELECT id FROM team_discussion_deleted_rooms WHERE id = ?').get(room.id))
      throw new Error('teamDiscussionNotFound');
    this.db
      .prepare(
        `INSERT INTO team_discussion_rooms
      (id,title,members_json,rounds,revision,generation,state,source_session_id,created_at,updated_at,cwd,permission_mode,read_only)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        room.id,
        room.title,
        JSON.stringify(room.members),
        room.rounds,
        room.revision,
        room.generation,
        room.state,
        room.sourceSessionId ?? null,
        room.createdAt,
        room.updatedAt,
        room.cwd,
        room.permissionMode,
        room.readOnly !== false ? 1 : 0,
      );
    if (room.summarySource)
      this.db
        .prepare('UPDATE team_discussion_rooms SET summary_source_json = ? WHERE id = ?')
        .run(JSON.stringify(room.summarySource), room.id);
  }
  updatePreparation(
    id: string,
    members: TeamDiscussionRoom['members'],
    state: 'preparing' | 'prepare_failed' | 'ready',
  ): void {
    this.db
      .prepare(
        `UPDATE team_discussion_rooms SET members_json = ?, state = ?, updated_at = ?
      WHERE id = ? AND state IN ('preparing','prepare_failed')`,
      )
      .run(JSON.stringify(members), state, Date.now(), id);
  }
  updateMembers(
    id: string,
    expectedRevision: number,
    members: TeamDiscussionRoom['members'],
  ): void {
    if (this.hasUnsettledSummary(id) || this.queue.hasActive(id))
      throw new Error('teamDiscussionBusy');
    const result = this.db
      .prepare(
        "UPDATE team_discussion_rooms SET members_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state = 'ready' AND active_discussion_id IS NULL",
      )
      .run(JSON.stringify(members), Date.now(), id, expectedRevision);
    if (result.changes !== 1) throw new Error('teamDiscussionStaleRevision');
  }
  beginDelete(id: string): void {
    this.db.transaction(() => {
      this.assertSettled(id);
      this.db
        .prepare(
          "UPDATE team_discussion_rooms SET state = 'deleting', generation = generation + 1 WHERE id = ?",
        )
        .run(id);
    })();
  }
  markMemberDeleted(id: string, agentId: string): void {
    const room = this.get(id);
    if (!room || room.state !== TeamDiscussionState.DELETING) throw new Error('teamDiscussionBusy');
    this.db
      .prepare('UPDATE team_discussion_rooms SET members_json = ? WHERE id = ?')
      .run(
        JSON.stringify(
          room.members.map(member =>
            member.agentId === agentId ? { ...member, deleted: true } : member,
          ),
        ),
        id,
      );
  }
  remove(id: string): void {
    this.db.transaction(() => {
      const room = this.get(id);
      if (
        !room ||
        room.state !== TeamDiscussionState.DELETING ||
        room.members.some(member => !member.deleted)
      )
        throw new Error('teamDiscussionBusy');
      this.db
        .prepare(
          'DELETE FROM team_discussion_executions WHERE discussion_id IN (SELECT id FROM team_discussion_runs WHERE room_id = ?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM team_discussion_task_links WHERE room_id = ?').run(id);
      this.db.prepare('DELETE FROM team_discussion_summaries WHERE room_id = ?').run(id);
      this.queue.remove(id);
      this.db.prepare('DELETE FROM team_discussion_runs WHERE room_id = ?').run(id);
      this.db
        .prepare('INSERT OR IGNORE INTO team_discussion_deleted_rooms VALUES (?, ?)')
        .run(id, Date.now());
      this.db.prepare('DELETE FROM team_discussion_rooms WHERE id = ?').run(id);
    })();
  }
  createTaskLink(roomId: string, requestId: string, create: () => string): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT session_id FROM team_discussion_task_links WHERE room_id = ? AND request_id = ?',
        )
        .get(roomId, requestId) as { session_id: string } | undefined;
      if (existing) return existing.session_id;
      const sessionId = create();
      this.db
        .prepare('INSERT INTO team_discussion_task_links VALUES (?, ?, ?)')
        .run(roomId, requestId, sessionId);
      return sessionId;
    })();
  }
  latestRun(
    roomId: string,
  ): { discussionId: string; requestId: string; state: string } | undefined {
    return this.db
      .prepare(
        'SELECT id AS discussionId, request_id AS requestId, state FROM team_discussion_runs WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(roomId) as { discussionId: string; requestId: string; state: string } | undefined;
  }
  runs(roomId: string): { discussionId: string; requestId: string; state: string }[] {
    return this.db
      .prepare(
        'SELECT id AS discussionId, request_id AS requestId, state FROM team_discussion_runs WHERE room_id = ? ORDER BY created_at, rowid',
      )
      .all(roomId) as { discussionId: string; requestId: string; state: string }[];
  }
  runIds(roomId: string): string[] {
    return (
      this.db
        .prepare('SELECT id FROM team_discussion_runs WHERE room_id = ? ORDER BY created_at, id')
        .all(roomId) as { id: string }[]
    ).map(row => row.id);
  }
  initiator(discussionId: string): string | undefined {
    return (
      (
        this.db
          .prepare('SELECT initiator_agent_id FROM team_discussion_runs WHERE id = ?')
          .get(discussionId) as { initiator_agent_id?: string } | undefined
      )?.initiator_agent_id || undefined
    );
  }
  requestRevision(roomId: string, requestId: string): number | undefined {
    return (
      this.db
        .prepare('SELECT revision FROM team_discussion_runs WHERE room_id = ? AND request_id = ?')
        .get(roomId, requestId) as { revision: number } | undefined
    )?.revision;
  }
  requestRounds(roomId: string, requestId: string): number | undefined {
    return (
      (
        this.db
          .prepare(
            'SELECT requested_rounds FROM team_discussion_runs WHERE room_id = ? AND request_id = ?',
          )
          .get(roomId, requestId) as { requested_rounds?: number } | undefined
      )?.requested_rounds ?? undefined
    );
  }
  resources(roomId: string, requestId: string): DiscussionResources | undefined {
    const row = this.db
      .prepare(
        'SELECT resources_json FROM team_discussion_runs WHERE room_id = ? AND request_id = ?',
      )
      .get(roomId, requestId) as { resources_json: string | null } | undefined;
    return row?.resources_json
      ? parseDiscussionResources(JSON.parse(row.resources_json))
      : undefined;
  }
  reserve(
    value: unknown,
    initiatorAgentId?: string,
    resources?: DiscussionResources,
    pendingRequestId?: string,
  ): {
    discussionId: string;
    generation: number;
    state: string;
    reused: boolean;
  } {
    const send = parseTeamDiscussionSend(value);
    // Canonicalize sets; names, object property order and frontend serialization
    // cannot change the identity of the same intended recipients.
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          send.roomId,
          send.expectedRevision,
          send.message,
          [...send.selectedAgentIds].sort(),
          send.rounds,
          send.attachmentPaths ?? [],
          send.quotes ?? [],
          ...(initiatorAgentId ? [{ initiatorAgentId }] : []),
        ]),
      )
      .digest('hex');
    return this.db.transaction(() => {
      const room = this.get(send.roomId);
      if (!room) throw new Error('teamDiscussionNotFound');
      const previous = this.db
        .prepare('SELECT * FROM team_discussion_runs WHERE room_id = ? AND request_id = ?')
        .get(send.roomId, send.requestId) as RunRow | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('teamDiscussionRequestConflict');
        return {
          discussionId: previous.id,
          generation: previous.generation,
          state: previous.state,
          reused: true,
        };
      }
      assertTeamDiscussionRecipients(room, send);
      if (this.queue.hasActive(room.id)) {
        const head = this.queue.list(room.id, true)[0];
        if (
          head?.state !== 'dispatching' ||
          head.requestId !== pendingRequestId ||
          head.requestId !== send.requestId
        )
          throw new Error('teamDiscussionBusy');
      }
      if (
        room.state !== TeamDiscussionState.READY ||
        room.activeDiscussionId ||
        this.hasUnsettledSummary(room.id)
      )
        throw new Error('teamDiscussionBusy');
      const id = randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO team_discussion_runs
        (id,room_id,request_id,fingerprint,revision,generation,state,created_at,updated_at,initiator_agent_id)
        VALUES (?,?,?,?,?,?,'submitting',?,?,?)`,
        )
        .run(
          id,
          room.id,
          send.requestId,
          fingerprint,
          room.revision,
          room.generation,
          now,
          now,
          initiatorAgentId ?? null,
        );
      this.db
        .prepare('UPDATE team_discussion_runs SET requested_rounds = ? WHERE id = ?')
        .run(send.rounds, id);
      if (resources)
        this.db
          .prepare('UPDATE team_discussion_runs SET resources_json = ? WHERE id = ?')
          .run(JSON.stringify(parseDiscussionResources(resources)), id);
      const reserved = this.db
        .prepare(
          `UPDATE team_discussion_rooms SET state = 'submitting', active_discussion_id = ?, updated_at = ?
        WHERE id = ? AND state = 'ready' AND active_discussion_id IS NULL`,
        )
        .run(id, now, room.id);
      if (reserved.changes !== 1) throw new Error('teamDiscussionBusy');
      return { discussionId: id, generation: room.generation, state: 'submitting', reused: false };
    })();
  }
  /** Preserve the admitted slot while projecting an exact uncertain native receipt. */
  markUncertain(roomId: string, discussionId: string, generation: number): boolean {
    return this.db.transaction(() => {
      const room = this.get(roomId);
      if (
        !room ||
        room.activeDiscussionId !== discussionId ||
        room.generation !== generation ||
        [
          TeamDiscussionState.DELETING,
          TeamDiscussionState.STOPPING,
          TeamDiscussionState.INTERRUPTED,
        ].includes(room.state as 'deleting' | 'stopping' | 'interrupted')
      )
        return false;
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE team_discussion_runs SET state = 'interrupted', updated_at = ? WHERE id = ? AND room_id = ?",
        )
        .run(now, discussionId, roomId);
      this.db
        .prepare(
          "UPDATE team_discussion_rooms SET state = 'interrupted', updated_at = ? WHERE id = ?",
        )
        .run(now, roomId);
      return true;
    })();
  }
  transition(
    roomId: string,
    discussionId: string,
    generation: number,
    state: 'running' | 'completed' | 'failed' | 'cancelled',
    options: { suppressSummary?: boolean } = {},
  ): boolean {
    return this.db.transaction(() => {
      const room = this.get(roomId);
      if (
        !room ||
        room.activeDiscussionId !== discussionId ||
        room.generation !== generation ||
        room.state === TeamDiscussionState.DELETING
      )
        return false;
      if (
        state === 'running' &&
        !(
          [TeamDiscussionState.SUBMITTING, TeamDiscussionState.INTERRUPTED] as TeamDiscussionState[]
        ).includes(room.state)
      )
        return false;
      const terminal = state !== 'running';
      const now = Date.now();
      const suppressed = this.db
        .prepare('SELECT summary_suppressed FROM team_discussion_runs WHERE id = ?')
        .get(discussionId) as { summary_suppressed: number } | undefined;
      if (
        (state === 'completed' || state === 'failed') &&
        room.summarySource &&
        room.sourceSessionId &&
        !suppressed?.summary_suppressed &&
        !options.suppressSummary &&
        room.state !== TeamDiscussionState.STOPPING
      )
        this.db
          .prepare(
            "INSERT OR IGNORE INTO team_discussion_summaries (discussion_id,room_id,state,updated_at) VALUES (?,?,'pending',?)",
          )
          .run(discussionId, roomId, now);
      this.db
        .prepare(
          'UPDATE team_discussion_runs SET state = ?, updated_at = ? WHERE id = ? AND room_id = ?',
        )
        .run(state, now, discussionId, roomId);
      this.db
        .prepare(
          'UPDATE team_discussion_rooms SET state = ?, active_discussion_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          terminal ? TeamDiscussionState.READY : TeamDiscussionState.RUNNING,
          terminal ? null : discussionId,
          now,
          roomId,
        );
      return true;
    })();
  }
  freeze(roomId: string): TeamDiscussionRoom {
    return this.db.transaction(() => {
      const room = this.get(roomId);
      if (!room) throw new Error('teamDiscussionNotFound');
      if (
        !room.activeDiscussionId ||
        room.state === TeamDiscussionState.STOPPING ||
        room.state === TeamDiscussionState.DELETING
      )
        return room;
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE team_discussion_rooms SET state = 'stopping', generation = generation + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, roomId);
      this.db
        .prepare(
          "UPDATE team_discussion_runs SET state = 'stopping', summary_suppressed = 1, generation = generation + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, room.activeDiscussionId);
      return this.get(roomId)!;
    })();
  }
  recoverInterrupted(): void {
    this.db.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE team_discussion_rooms SET state = CASE WHEN state = 'stopping' THEN 'stopping' ELSE 'interrupted' END, generation = generation + 1, updated_at = ? WHERE state IN ('submitting','running','stopping')",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE team_discussion_runs SET state = CASE WHEN state = 'stopping' THEN 'stopping' ELSE 'interrupted' END, generation = generation + 1, updated_at = ? WHERE state IN ('submitting','running','stopping')",
        )
        .run(now);
    })();
  }
  recordExecution(execution: TeamDiscussionExecution): void {
    const run = this.db
      .prepare('SELECT * FROM team_discussion_runs WHERE id = ?')
      .get(execution.discussionId) as RunRow | undefined;
    const room = run && this.get(run.room_id);
    if (!room || !room.members.some(member => member.agentId === execution.agentId))
      throw new Error('teamDiscussionInvalidMembers');
    const previous = this.db
      .prepare(
        `SELECT agent_id,session_key,session_id,lifecycle_revision FROM team_discussion_executions
      WHERE discussion_id = ? AND run_id = ?`,
      )
      .get(execution.discussionId, execution.runId) as Record<string, string> | undefined;
    if (previous) {
      if (
        previous.agent_id !== execution.agentId ||
        previous.session_key !== execution.sessionKey ||
        previous.session_id !== execution.sessionId ||
        previous.lifecycle_revision !== execution.lifecycleRevision
      ) {
        throw new Error('teamDiscussionExecutionConflict');
      }
      if (execution.outcome)
        this.db
          .prepare(
            'UPDATE team_discussion_executions SET outcome = ? WHERE discussion_id = ? AND run_id = ?',
          )
          .run(execution.outcome, execution.discussionId, execution.runId);
      return;
    }
    this.db
      .prepare('INSERT INTO team_discussion_executions VALUES (?,?,?,?,?,?,?)')
      .run(
        execution.discussionId,
        execution.agentId,
        execution.sessionKey,
        execution.sessionId,
        execution.lifecycleRevision,
        execution.runId,
        execution.outcome ?? null,
      );
  }
  executions(discussionId: string): TeamDiscussionExecution[] {
    return this.db
      .prepare(
        `SELECT discussion_id AS discussionId, agent_id AS agentId, session_key AS sessionKey,
      session_id AS sessionId, lifecycle_revision AS lifecycleRevision, run_id AS runId, outcome
      FROM team_discussion_executions WHERE discussion_id = ? ORDER BY rowid`,
      )
      .all(discussionId) as TeamDiscussionExecution[];
  }
}
