import type Database from 'better-sqlite3';

import {
  type AgentTeamKind,
  type AgentTeamSettingsSnapshot,
  type AgentTeamSettingsView,
  defaultAgentTeamSettings,
  parseAgentTeamOverrides,
  parseAgentTeamSettings,
  settingsInteger,
  settingsRecord,
} from '../../contracts/agentTeamSettings';

const KEY = 'agentTeam.settings';
const tables = {
  collaboration: 'collaboration_rooms',
  discussion: 'team_discussion_rooms',
} as const;

/** SQLite is the only preference authority. Reads and saves never start a Gateway. */
export class AgentTeamSettingsService {
  constructor(private readonly db: Database.Database) {}
  read(): AgentTeamSettingsSnapshot {
    if (
      !this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
    )
      return { version: 1, revision: 0, value: defaultAgentTeamSettings() };
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(KEY) as
      { value: string } | undefined;
    if (!row) return { version: 1, revision: 0, value: defaultAgentTeamSettings() };
    const input = settingsRecord(JSON.parse(row.value), ['version', 'revision', 'value']);
    if (input.version !== 1) throw new Error('agentTeamSettingsInvalid');
    return {
      version: 1,
      revision: settingsInteger(input.revision, 0, Number.MAX_SAFE_INTEGER),
      value: parseAgentTeamSettings(input.value),
    };
  }
  save(value: unknown, expectedRevision: unknown): AgentTeamSettingsSnapshot {
    const parsed = parseAgentTeamSettings(value);
    settingsInteger(expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    return this.db.transaction(() => {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new Error('agentTeamSettingsConflict');
      const next: AgentTeamSettingsSnapshot = {
        version: 1,
        revision: settingsInteger(current.revision + 1, 1, Number.MAX_SAFE_INTEGER),
        value: parsed,
      };
      this.db
        .prepare(
          `INSERT INTO kv(key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        )
        .run(KEY, JSON.stringify(next), Date.now());
      return next;
    })();
  }
  readTeam(kind: AgentTeamKind, roomId: string): AgentTeamSettingsView {
    if (!Object.hasOwn(tables, kind) || !/^[a-zA-Z0-9_-]{1,128}$/.test(roomId))
      throw new Error('agentTeamSettingsInvalid');
    const row = this.db
      .prepare(`SELECT settings_json FROM ${tables[kind]} WHERE id = ?`)
      .get(roomId) as { settings_json: string | null } | undefined;
    if (!row) throw new Error('teamDiscussionNotFound');
    const stored = row.settings_json
      ? settingsRecord(JSON.parse(row.settings_json), ['revision', 'value'])
      : { revision: 0, value: {} };
    const memberCount =
      kind === 'collaboration'
        ? (
            this.db
              .prepare('SELECT COUNT(*) AS n FROM collaboration_members WHERE room_id = ?')
              .get(roomId) as { n: number }
          ).n
        : (
            JSON.parse(
              (
                this.db
                  .prepare('SELECT members_json FROM team_discussion_rooms WHERE id = ?')
                  .get(roomId) as { members_json: string }
              ).members_json,
            ) as unknown[]
          ).length;
    return {
      global: this.read(),
      team: {
        revision: settingsInteger(stored.revision, 0, Number.MAX_SAFE_INTEGER),
        value: parseAgentTeamOverrides(stored.value, kind),
      },
      memberCount,
    };
  }
  saveTeam(
    kind: AgentTeamKind,
    roomId: string,
    value: unknown,
    expectedRevision: unknown,
  ): AgentTeamSettingsView {
    const parsed = parseAgentTeamOverrides(value, kind);
    settingsInteger(expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    return this.db.transaction(() => {
      const current = this.readTeam(kind, roomId);
      if (current.team.revision !== expectedRevision) throw new Error('agentTeamSettingsConflict');
      const limits = current.global.value;
      if (
        (parsed.messageBudget ?? 0) > limits.collaboration.messageBudget ||
        (parsed.defaultRounds ?? 0) > limits.discussion.maxRounds ||
        (parsed.maxTurns ?? 0) > (limits.discussion.maxTurns ?? 24) ||
        (parsed.maxConcurrent ?? 0) > (limits.discussion.maxConcurrent ?? 6)
      )
        throw new Error('agentTeamSettingsOverrideExceeded');
      const next = {
        revision: settingsInteger(current.team.revision + 1, 1, Number.MAX_SAFE_INTEGER),
        value: parsed,
      };
      this.db
        .prepare(`UPDATE ${tables[kind]} SET settings_json = ? WHERE id = ?`)
        .run(JSON.stringify(next), roomId);
      return this.readTeam(kind, roomId);
    })();
  }
}
