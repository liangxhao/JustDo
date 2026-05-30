import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  return path.join(os.homedir(), 'gucciai', 'project');
};

const TASK_WORKSPACE_CONTAINER_DIR = '.gucciai-tasks';

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  return resolved;
};

function extractConversationSearchTerms(value: string): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return [];

  const terms: string[] = [];
  const seen = new Set<string>();
  const addTerm = (term: string): void => {
    const normalizedTerm = term.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalizedTerm) return;
    if (/^[a-z0-9]$/i.test(normalizedTerm)) return;
    if (seen.has(normalizedTerm)) return;
    seen.add(normalizedTerm);
    terms.push(normalizedTerm);
  };

  // Keep the full phrase and additionally match by per-token terms.
  addTerm(normalized);
  const tokens = normalized
    .split(/[\s,，、|/\\;；]+/g)
    .map(token => token.replace(/^['"`]+|['"`]+$/g, '').trim())
    .filter(Boolean);

  for (const token of tokens) {
    addTerm(token);
    if (terms.length >= 8) break;
  }

  return terms.slice(0, 8);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function parseTimeToMs(input?: string | null): number | null {
  if (!input) return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

// Types mirroring src/types/cowork.ts for main process use
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';
export type CoworkMessageType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'subagent_completion';
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';
export type CoworkAgentEngine = 'openclaw';

export type AgentSource = 'custom' | 'preset';

// Subagent status types for UI cache persistence. OpenClaw Gateway remains the
// authority for Subagent lifecycle and parent/child lineage.
export type SubagentStatusType = 'pending' | 'running' | 'done' | 'failed';

export interface SubagentRecord {
  toolCallId: string;
  parentSessionId: string;
  childSessionKey: string | null;
  label: string;
  status: SubagentStatusType;
  toolInput: Record<string, unknown> | null;
  errorReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  model: string;
  icon: string;
  skillIds: string[];
  enabled: boolean;
  isDefault: boolean;
  source: AgentSource;
  presetId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentRequest {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  source?: AgentSource;
  presetId?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  enabled?: boolean;
}

const COWORK_AGENT_ENGINE = 'openclaw';

function normalizeCoworkAgentEngineValue(value?: string | null): CoworkAgentEngine {
  if (value === COWORK_AGENT_ENGINE || value === 'openclaw') {
    return value;
  }
  return COWORK_AGENT_ENGINE;
}

export interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string | Record<string, unknown>;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  skillIds?: string[];
  [key: string]: unknown;
}

export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string; // Accumulated thinking content during streaming
  modelName?: string; // Model that generated this message (for assistant messages)
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; // Token usage
}

export interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: CoworkSessionStatus;
  pinned: boolean;
  cwd: string;
  executionMode: CoworkExecutionMode;
  activeSkillIds: string[];
  agentId: string;
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  groupId: string | null;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkConversationSearchRecord {
  sessionId: string;
  title: string;
  updatedAt: number;
  url: string;
  human: string;
  assistant: string;
}

export interface CoworkConfig {
  workingDirectory: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
}

export type CoworkConfigUpdate = Partial<
  Pick<CoworkConfig, 'workingDirectory' | 'executionMode' | 'agentEngine'>
>;

interface CoworkMessageRow {
  id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
  sequence: number | null;
  thinking_content: string | null;
  model_name: string | null;
  usage: string | null;
}

export class CoworkStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  createSession(
    title: string,
    cwd: string,
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = [],
    agentId: string = 'main',
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO cowork_sessions (id, title, claude_session_id, status, cwd, execution_mode, active_skill_ids, agent_id, pinned, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, 0, ?, ?)
    `,
      )
      .run(id, title, cwd, executionMode, JSON.stringify(activeSkillIds), agentId, now, now);

    return {
      id,
      title,
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd,
      executionMode,
      activeSkillIds,
      agentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: string): CoworkSession | null {
    interface SessionRow {
      id: string;
      title: string;
      claude_session_id: string | null;
      status: string;
      pinned?: number | null;
      cwd: string;
      execution_mode?: string | null;
      active_skill_ids?: string | null;
      agent_id?: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionRow>(
      `
      SELECT id, title, claude_session_id, status, pinned, cwd, execution_mode, active_skill_ids, agent_id, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `,
      [id],
    );

    if (!row) return null;

    const messages = this.getSessionMessages(id);

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch (e) {
        console.error('[CoworkStore] Failed to parse active_skill_ids for session', id, e);
        activeSkillIds = [];
      }
    }

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      cwd: row.cwd,
      executionMode: (row.execution_mode as CoworkExecutionMode) || 'local',
      activeSkillIds,
      agentId: row.agent_id || 'main',
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateSession(
    id: string,
    updates: Partial<
      Pick<CoworkSession, 'title' | 'claudeSessionId' | 'status' | 'cwd' | 'executionMode'>
    >,
  ): void {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.claudeSessionId !== undefined) {
      setClauses.push('claude_session_id = ?');
      values.push(updates.claudeSessionId);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(updates.cwd);
    }
    if (updates.executionMode !== undefined) {
      setClauses.push('execution_mode = ?');
      values.push(updates.executionMode);
    }

    values.push(id);
    this.db
      .prepare(
        `
      UPDATE cowork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `,
      )
      .run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run(id);
  }

  deleteSessions(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM cowork_sessions WHERE id IN (${placeholders})`).run(...ids);
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE cowork_sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  listSessions(agentId?: string): CoworkSessionSummary[] {
    interface SessionSummaryRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      agent_id: string | null;
      group_id: string | null;
      created_at: number;
      updated_at: number;
    }

    let rows: SessionSummaryRow[];
    if (agentId) {
      rows = this.getAll<SessionSummaryRow>(
        `
        SELECT id, title, status, pinned, agent_id, group_id, created_at, updated_at
        FROM cowork_sessions
        WHERE agent_id = ?
        ORDER BY pinned DESC, updated_at DESC
      `,
        [agentId],
      );
    } else {
      rows = this.getAll<SessionSummaryRow>(`
        SELECT id, title, status, pinned, agent_id, group_id, created_at, updated_at
        FROM cowork_sessions
        ORDER BY pinned DESC, updated_at DESC
      `);
    }

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      agentId: row.agent_id || 'main',
      groupId: row.group_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  resetRunningSessions(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `
      UPDATE cowork_sessions
      SET status = 'idle', updated_at = ?
      WHERE status = 'running'
    `,
      )
      .run(now);
    return result.changes;
  }

  listRecentCwds(limit: number = 8): string[] {
    interface CwdRow {
      cwd: string;
      updated_at: number;
    }

    const rows = this.getAll<CwdRow>(
      `
      SELECT cwd, updated_at
      FROM cowork_sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      [Math.max(limit * 8, limit)],
    );

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeRecentWorkspacePath(row.cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }

  private getSessionMessages(sessionId: string): CoworkMessage[] {
    const rows = this.getAll<CoworkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence, thinking_content, model_name, usage
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY
        COALESCE(sequence, created_at) ASC,
        created_at ASC,
        ROWID ASC
    `,
      [sessionId],
    );

    const messages = rows.map(row => {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          console.warn(
            `[CoworkStore] corrupt metadata detected for message ${row.id} in session ${sessionId}, discarding metadata`,
          );
          metadata = undefined;
        }
      }
      return {
        id: row.id,
        type: row.type as CoworkMessageType,
        content: row.content,
        timestamp: row.created_at,
        metadata,
        ...(row.thinking_content ? { thinkingContent: row.thinking_content } : {}),
        ...(row.model_name ? { modelName: row.model_name } : {}),
        ...(row.usage ? { usage: JSON.parse(row.usage) } : {}),
      };
    });
    return messages;
  }

  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage {
    const id = uuidv4();
    const now = Date.now();

    const seqRow = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM cowork_messages WHERE session_id = ?',
      )
      .get(sessionId) as { next_seq: number } | undefined;
    const sequence = seqRow?.next_seq ?? 1;

    this.db
      .prepare(
        `
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence, thinking_content, model_name, usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        sessionId,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        now,
        sequence,
        message.thinkingContent || null,
        message.modelName || null,
        message.usage ? JSON.stringify(message.usage) : null,
      );

    this.db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
      // Include thinkingContent if provided (used for streaming thinking display)
      ...(message.thinkingContent ? { thinkingContent: message.thinkingContent } : {}),
      // Include modelName if provided (used to display which model generated this message)
      ...(message.modelName ? { modelName: message.modelName } : {}),
      // Include usage if provided (used to display token counts)
      ...(message.usage ? { usage: message.usage } : {}),
    };
  }

  /**
   * Insert a message with a pre-existing ID (used for runtime-emitted messages that need to persist).
   * Returns the inserted message or the existing one if already present.
   */
  insertMessageWithId(sessionId: string, message: CoworkMessage): CoworkMessage {
    // Check if message already exists
    const existing = this.db
      .prepare('SELECT * FROM cowork_messages WHERE id = ?')
      .get(message.id) as CoworkMessage | undefined;
    if (existing) {
      return existing;
    }

    const seqRow = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM cowork_messages WHERE session_id = ?',
      )
      .get(sessionId) as { next_seq: number } | undefined;
    const sequence = seqRow?.next_seq ?? 1;

    this.db
      .prepare(
        `
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence, thinking_content, model_name, usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        message.id,
        sessionId,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.timestamp,
        sequence,
        message.thinkingContent || null,
        message.modelName || null,
        message.usage ? JSON.stringify(message.usage) : null,
      );

    this.db
      .prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?')
      .run(message.timestamp, sessionId);

    return message;
  }

  /**
   * Insert a message before an existing message (by shifting sequences).
   * Used for channel-originated sessions where user messages need to appear
   * before assistant messages that were created during streaming.
   */
  insertMessageBeforeId(
    sessionId: string,
    beforeMessageId: string,
    message: Omit<CoworkMessage, 'id' | 'timestamp'>,
  ): CoworkMessage {
    const id = uuidv4();
    const now = Date.now();

    // Get the target message's sequence
    const targetRow = this.db
      .prepare('SELECT sequence FROM cowork_messages WHERE id = ? AND session_id = ?')
      .get(beforeMessageId, sessionId) as { sequence: number } | undefined;
    const targetSequence = targetRow?.sequence;

    if (targetSequence === undefined) {
      // Fallback to normal append if the target message is not found
      return this.addMessage(sessionId, message);
    }

    this.db.transaction(() => {
      // Shift all messages with sequence >= target up by 1
      this.db
        .prepare(
          'UPDATE cowork_messages SET sequence = sequence + 1 WHERE session_id = ? AND sequence >= ?',
        )
        .run(sessionId, targetSequence);

      // Insert at the target's original sequence
      this.db
        .prepare(
          `
        INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence, thinking_content, model_name, usage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          sessionId,
          message.type,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          now,
          targetSequence,
          message.thinkingContent || null,
          message.modelName || null,
          message.usage ? JSON.stringify(message.usage) : null,
        );

      this.db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    })();

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
      // Include thinkingContent if provided (used for streaming thinking display)
      ...(message.thinkingContent ? { thinkingContent: message.thinkingContent } : {}),
      // Include modelName if provided (used to display which model generated this message)
      ...(message.modelName ? { modelName: message.modelName } : {}),
      // Include usage if provided (used to display token counts)
      ...(message.usage ? { usage: message.usage } : {}),
    };
  }

  /**
   * Delete a message from a session.
   * Used by reconciliation to remove duplicate or spurious messages.
   */
  deleteMessage(sessionId: string, messageId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM cowork_messages WHERE id = ? AND session_id = ?')
      .run(messageId, sessionId);
    return result.changes > 0;
  }

  /**
   * Refresh the local user/assistant message cache from Gateway chat.history.
   * Tool messages (tool_use, tool_result, system) are preserved in their existing positions.
   * This updates SQLite for UI display only; Runtime behavior must use OpenClaw Gateway state.
   */
  replaceConversationMessages(
    sessionId: string,
    authoritative: Array<{
      role: 'user' | 'assistant';
      text: string;
      modelName?: string;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    }>,
  ): void {
    const now = Date.now();

    this.db.transaction(() => {
      // Delete all existing user/assistant messages for this session
      this.db
        .prepare(
          "DELETE FROM cowork_messages WHERE session_id = ? AND type IN ('user', 'assistant')",
        )
        .run(sessionId);

      // Re-insert authoritative messages with correct sequence numbers
      // First, get the current max sequence from remaining messages (tool_use, tool_result, system)
      const seqRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM cowork_messages WHERE session_id = ?',
        )
        .get(sessionId) as { max_seq: number } | undefined;
      let nextSeq = (seqRow?.max_seq ?? 0) + 1;

      for (const entry of authoritative) {
        const id = uuidv4();
        this.db
          .prepare(
            `
          INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence, model_name, usage)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            id,
            sessionId,
            entry.role,
            entry.text,
            JSON.stringify({ isStreaming: false, isFinal: true }),
            now,
            nextSeq++,
            entry.modelName || null,
            entry.usage ? JSON.stringify(entry.usage) : null,
          );
      }

      this.db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    })();
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    updates: {
      content?: string;
      metadata?: CoworkMessageMetadata;
      thinkingContent?: string;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    },
  ): void {
    const setClauses: string[] = [];
    const values: (string | null)[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.thinkingContent !== undefined) {
      setClauses.push('thinking_content = ?');
      values.push(updates.thinkingContent || null);
    }
    if (updates.usage !== undefined) {
      setClauses.push('usage = ?');
      values.push(updates.usage ? JSON.stringify(updates.usage) : null);
    }

    if (setClauses.length === 0) return;

    values.push(messageId);
    values.push(sessionId);
    this.db
      .prepare(
        `
      UPDATE cowork_messages
      SET ${setClauses.join(', ')}
      WHERE id = ? AND session_id = ?
    `,
      )
      .run(...values);

    // Bump session's updated_at so it stays at top of the list during streaming updates
    this.db
      .prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  // Config operations
  getConfig(): CoworkConfig {
    const configKeys = ['workingDirectory', 'executionMode', 'agentEngine'] as const;
    const configRows = this.getAll<{ key: string; value: string }>(
      `SELECT key, value FROM cowork_config WHERE key IN (${configKeys.map(() => '?').join(', ')})`,
      [...configKeys],
    );
    const cfg = new Map(configRows.map(r => [r.key, r.value]));

    return {
      workingDirectory: cfg.get('workingDirectory') || getDefaultWorkingDirectory(),
      executionMode: 'local' as CoworkExecutionMode,
      agentEngine: normalizeCoworkAgentEngineValue(cfg.get('agentEngine')),
    };
  }

  setConfig(config: CoworkConfigUpdate): void {
    const now = Date.now();

    if (config.workingDirectory !== undefined) {
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('workingDirectory', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(config.workingDirectory, now);
    }

    if (config.executionMode !== undefined) {
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('executionMode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(config.executionMode, now);
    }

    if (config.agentEngine !== undefined) {
      const normalizedAgentEngine = normalizeCoworkAgentEngineValue(config.agentEngine);
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('agentEngine', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(normalizedAgentEngine, now);
    }
  }

  getAppLanguage(): 'zh' | 'en' {
    interface KvRow {
      value: string;
    }

    const row = this.getOne<KvRow>('SELECT value FROM kv WHERE key = ?', ['app_config']);
    if (!row?.value) {
      return 'zh';
    }

    try {
      const config = JSON.parse(row.value) as { language?: string };
      return config.language === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  }

  private getLatestMessageByType(sessionId: string, type: 'user' | 'assistant'): string {
    const row = this.getOne<{ content: string }>(
      `
      SELECT content
      FROM cowork_messages
      WHERE session_id = ? AND type = ?
      ORDER BY created_at DESC, ROWID DESC
      LIMIT 1
    `,
      [sessionId, type],
    );
    return truncate((row?.content || '').replace(/\s+/g, ' ').trim(), 280);
  }

  conversationSearch(options: {
    query: string;
    maxResults?: number;
    before?: string;
    after?: string;
  }): CoworkConversationSearchRecord[] {
    const terms = extractConversationSearchTerms(options.query);
    if (terms.length === 0) return [];

    const maxResults = Math.max(1, Math.min(10, Math.floor(options.maxResults ?? 5)));
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const likeClauses = terms.map(() => 'LOWER(m.content) LIKE ?');
    const clauses: string[] = ["m.type IN ('user', 'assistant')", `(${likeClauses.join(' OR ')})`];
    const params: Array<string | number> = terms.map(term => `%${term}%`);

    if (beforeMs !== null) {
      clauses.push('m.created_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('m.created_at > ?');
      params.push(afterMs);
    }

    const rows = this.getAll<{
      session_id: string;
      title: string;
      updated_at: number;
      type: string;
      content: string;
      created_at: number;
    }>(
      `
      SELECT m.session_id, s.title, s.updated_at, m.type, m.content, m.created_at
      FROM cowork_messages m
      INNER JOIN cowork_sessions s ON s.id = m.session_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?
    `,
      [...params, maxResults * 40],
    );

    const bySession = new Map<string, CoworkConversationSearchRecord>();
    for (const row of rows) {
      if (!row.session_id) continue;
      let current = bySession.get(row.session_id);
      if (!current) {
        current = {
          sessionId: row.session_id,
          title: row.title || 'Untitled',
          updatedAt: Number(row.updated_at) || 0,
          url: '',
          human: '',
          assistant: '',
        };
        bySession.set(row.session_id, current);
      }

      const snippet = truncate((row.content || '').replace(/\s+/g, ' ').trim(), 280);
      if (row.type === 'user' && !current.human) {
        current.human = snippet;
      }
      if (row.type === 'assistant' && !current.assistant) {
        current.assistant = snippet;
      }

      if (bySession.size >= maxResults) {
        const complete = Array.from(bySession.values()).every(
          entry => entry.human && entry.assistant,
        );
        if (complete) break;
      }
    }

    const records = Array.from(bySession.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxResults)
      .map(entry => ({
        ...entry,
        human: entry.human || this.getLatestMessageByType(entry.sessionId, 'user'),
        assistant: entry.assistant || this.getLatestMessageByType(entry.sessionId, 'assistant'),
      }));

    return records;
  }

  recentChats(options: {
    n?: number;
    sortOrder?: 'asc' | 'desc';
    before?: string;
    after?: string;
  }): CoworkConversationSearchRecord[] {
    const n = Math.max(1, Math.min(20, Math.floor(options.n ?? 3)));
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (beforeMs !== null) {
      clauses.push('updated_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('updated_at > ?');
      params.push(afterMs);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.getAll<{
      id: string;
      title: string;
      updated_at: number;
    }>(
      `
      SELECT id, title, updated_at
      FROM cowork_sessions
      ${whereClause}
      ORDER BY updated_at ${sortOrder.toUpperCase()}
      LIMIT ?
    `,
      [...params, n],
    );

    return rows.map(row => ({
      sessionId: row.id,
      title: row.title || 'Untitled',
      updatedAt: Number(row.updated_at) || 0,
      url: '',
      human: this.getLatestMessageByType(row.id, 'user'),
      assistant: this.getLatestMessageByType(row.id, 'assistant'),
    }));
  }

  // ========== Agent CRUD ==========

  listAgents(): Agent[] {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      icon: string;
      skill_ids: string;
      enabled: number;
      is_default: number;
      source: string;
      preset_id: string;
      created_at: number;
      updated_at: number;
    }

    const rows = this.getAll<AgentRow>(`
      SELECT * FROM agents ORDER BY is_default DESC, created_at ASC
    `);

    return rows.map(row => this.mapAgentRow(row));
  }

  getAgent(id: string): Agent | null {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      icon: string;
      skill_ids: string;
      enabled: number;
      is_default: number;
      source: string;
      preset_id: string;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [id]);
    if (!row) return null;
    return this.mapAgentRow(row);
  }

  createAgent(request: CreateAgentRequest): Agent {
    const id =
      request.id ||
      request.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') ||
      uuidv4();
    const now = Date.now();

    // Ensure no duplicate ID
    const existing = this.getAgent(id);
    if (existing) {
      // Append timestamp to make unique
      return this.createAgent({ ...request, id: `${id}-${Date.now()}` });
    }

    this.db
      .prepare(
        `
      INSERT INTO agents (id, name, description, system_prompt, identity, model, icon, skill_ids, enabled, is_default, source, preset_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        request.name,
        request.description || '',
        request.systemPrompt || '',
        request.identity || '',
        request.model || '',
        request.icon || '',
        JSON.stringify(request.skillIds || []),
        request.source || 'custom',
        request.presetId || '',
        now,
        now,
      );

    return this.getAgent(id)!;
  }

  backfillEmptyAgentModels(modelId: string): number {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) return 0;

    const result = this.db
      .prepare("UPDATE agents SET model = ?, updated_at = ? WHERE TRIM(COALESCE(model, '')) = ''")
      .run(normalizedModelId, Date.now());

    return result.changes;
  }

  updateAgent(id: string, updates: UpdateAgentRequest): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;

    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description);
    }
    if (updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.identity !== undefined) {
      setClauses.push('identity = ?');
      values.push(updates.identity);
    }
    if (updates.model !== undefined) {
      setClauses.push('model = ?');
      values.push(updates.model);
    }
    if (updates.icon !== undefined) {
      setClauses.push('icon = ?');
      values.push(updates.icon);
    }
    if (updates.skillIds !== undefined) {
      setClauses.push('skill_ids = ?');
      values.push(JSON.stringify(updates.skillIds));
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    values.push(id);
    this.db.prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    if (id === 'main') return false; // Cannot delete default agent
    this.db.prepare('DELETE FROM agents WHERE id = ? AND is_default = 0').run(id);
    return true;
  }

  private mapAgentRow(row: {
    id: string;
    name: string;
    description: string;
    system_prompt: string;
    identity: string;
    model: string;
    icon: string;
    skill_ids: string;
    enabled: number;
    is_default: number;
    source: string;
    preset_id: string;
    created_at: number;
    updated_at: number;
  }): Agent {
    let skillIds: string[] = [];
    try {
      skillIds = JSON.parse(row.skill_ids);
    } catch {
      skillIds = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      identity: row.identity,
      model: row.model,
      icon: row.icon,
      skillIds,
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      source: row.source as AgentSource,
      presetId: row.preset_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ========== Subagent Status CRUD ==========

  /**
   * Upsert a subagent status record.
   * Creates or updates the subagent entry with the given toolCallId.
   */
  upsertSubagent(
    toolCallId: string,
    parentSessionId: string,
    label: string,
    status: SubagentStatusType,
    options?: {
      childSessionKey?: string;
      toolInput?: Record<string, unknown>;
      errorReason?: string;
    },
  ): void {
    const now = Date.now();
    const toolInputJson = options?.toolInput ? JSON.stringify(options.toolInput) : null;
    const errorReason = options?.errorReason || null;
    const childSessionKey = options?.childSessionKey || null;

    this.db
      .prepare(
        `
      INSERT INTO cowork_subagents (tool_call_id, parent_session_id, child_session_key, label, status, tool_input, error_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_call_id) DO UPDATE SET
        parent_session_id = excluded.parent_session_id,
        child_session_key = COALESCE(excluded.child_session_key, cowork_subagents.child_session_key),
        label = COALESCE(excluded.label, cowork_subagents.label),
        status = excluded.status,
        tool_input = COALESCE(excluded.tool_input, cowork_subagents.tool_input),
        error_reason = COALESCE(excluded.error_reason, cowork_subagents.error_reason),
        updated_at = excluded.updated_at
    `,
      )
      .run(
        toolCallId,
        parentSessionId,
        childSessionKey,
        label,
        status,
        toolInputJson,
        errorReason,
        now,
        now,
      );
  }

  /**
   * Update subagent status only.
   */
  updateSubagentStatus(toolCallId: string, status: SubagentStatusType, errorReason?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE cowork_subagents
      SET status = ?, error_reason = COALESCE(?, error_reason), updated_at = ?
      WHERE tool_call_id = ?
    `,
      )
      .run(status, errorReason || null, now, toolCallId);
  }

  /**
   * Update subagent status by either the original tool call id or child session key.
   */
  updateSubagentStatusByIdentifier(
    identifier: string,
    status: SubagentStatusType,
    errorReason?: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE cowork_subagents
      SET status = ?, error_reason = COALESCE(?, error_reason), updated_at = ?
      WHERE tool_call_id = ? OR child_session_key = ?
    `,
      )
      .run(status, errorReason || null, now, identifier, identifier);
  }

  /**
   * Get all subagents for a parent session.
   */
  getSubagentsByParentSession(parentSessionId: string): SubagentRecord[] {
    interface SubagentRow {
      tool_call_id: string;
      parent_session_id: string;
      child_session_key: string | null;
      label: string;
      status: string;
      tool_input: string | null;
      error_reason: string | null;
      created_at: number;
      updated_at: number;
    }

    const rows = this.getAll<SubagentRow>(
      `
      SELECT * FROM cowork_subagents WHERE parent_session_id = ? ORDER BY created_at ASC
    `,
      [parentSessionId],
    );

    return rows.map(row => {
      let toolInput: Record<string, unknown> | null = null;
      if (row.tool_input) {
        try {
          toolInput = JSON.parse(row.tool_input);
        } catch {
          toolInput = null;
        }
      }
      return {
        toolCallId: row.tool_call_id,
        parentSessionId: row.parent_session_id,
        childSessionKey: row.child_session_key,
        label: row.label,
        status: row.status as SubagentStatusType,
        toolInput,
        errorReason: row.error_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Get a single subagent by toolCallId.
   */
  getSubagent(toolCallId: string): SubagentRecord | null {
    interface SubagentRow {
      tool_call_id: string;
      parent_session_id: string;
      child_session_key: string | null;
      label: string;
      status: string;
      tool_input: string | null;
      error_reason: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SubagentRow>(
      `
      SELECT * FROM cowork_subagents WHERE tool_call_id = ?
    `,
      [toolCallId],
    );

    if (!row) return null;

    let toolInput: Record<string, unknown> | null = null;
    if (row.tool_input) {
      try {
        toolInput = JSON.parse(row.tool_input);
      } catch {
        toolInput = null;
      }
    }
    return {
      toolCallId: row.tool_call_id,
      parentSessionId: row.parent_session_id,
      childSessionKey: row.child_session_key,
      label: row.label,
      status: row.status as SubagentStatusType,
      toolInput,
      errorReason: row.error_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Delete all subagents for a parent session (called when session is deleted).
   */
  deleteSubagentsByParentSession(parentSessionId: string): void {
    this.db
      .prepare('DELETE FROM cowork_subagents WHERE parent_session_id = ?')
      .run(parentSessionId);
  }

  /**
   * Delete a single subagent.
   */
  deleteSubagent(toolCallId: string): void {
    this.db.prepare('DELETE FROM cowork_subagents WHERE tool_call_id = ?').run(toolCallId);
  }
}
