import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { StartupHistorySummary } from '../../../shared/app/startup/routing';
import { DEFAULT_PERMISSION_MODE } from '../../../shared/security/approvals';
import { DB_FILENAME } from '../../core/appConstants';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import { writeStartupJson } from '../routing/startupState';
import { ownedPath } from './historyBackup';

type NativeEntry = Record<string, unknown> & { sessionId: string };
type NativeHistory = {
  agentId: string;
  entries: Record<string, NativeEntry>;
  transcriptFiles: Record<string, string>;
};
export type HistoryConversation = {
  id: string;
  title: string;
  pinned: boolean;
  groupId: string | null;
  agentId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  sessionKey: string;
  nativeSessionId: string;
  availability: 'native' | 'cache' | 'missing';
  originalBinding: { agentId: string; sessionKey: string; nativeSessionId: string | null };
  external?: { source: string; key: string; sessionKey: string | null; sessionId: string | null };
};
export type HistoryPlan = {
  version: 1;
  agents: NativeHistory[];
  groups: { id: string; name: string }[];
  conversations: HistoryConversation[];
  summary: StartupHistorySummary;
};
type LegacyMessage = {
  id: string;
  type: string;
  content: string;
  created_at: number;
  thinking_content?: string;
  metadata?: string;
};

const HISTORY_FIELDS = [
  'sessionId',
  'updatedAt',
  'sessionStartedAt',
  'parentSessionId',
  'spawnedBy',
  'spawnDepth',
  'subagentRole',
  'subagentControlScope',
  'compactionCount',
  'compactionCheckpoints',
  'label',
  'chatType',
  'previousSessionId',
  'usageFamilySessionIds',
] as const;
const stableId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const iso = (time: number) => new Date(time).toISOString();

function isTranscriptFilename(filename: string): boolean {
  return (
    filename.endsWith('.jsonl') &&
    !/[\\/:\0]/.test(filename) &&
    !filename.endsWith('.trajectory.jsonl')
  );
}

/** Localize native transcript pointers inside the verified backup, never the old absolute path. */
function transcriptFilename(folder: string, entry: NativeEntry): string {
  if (typeof entry.sessionFile === 'string') {
    const filename = path.win32.basename(entry.sessionFile.replaceAll('/', '\\'));
    if (isTranscriptFilename(filename) && fs.existsSync(ownedPath(folder, filename)))
      return filename;
  }
  return `${entry.sessionId}.jsonl`;
}

/** Locked native session-key normalization folds these legacy product namespaces.
 * Do not fold arbitrary external keys: Matrix/Signal contain case-sensitive peer IDs.
 * Source associations are retained separately, including the original spelling.
 */
export function canonicalHistoryKey(key: string): string {
  return /^agent:[a-z0-9_-]+:(?:justdo|multica):[^:]+$/i.test(key) ? key.trim().toLowerCase() : key;
}

/** Cache-only rows become inert historical text, never tool calls or execution receipts. */
export function convertCachedHistory(session: HistoryConversation, rows: LegacyMessage[]): string {
  const header = {
    type: 'session',
    version: 3,
    id: session.nativeSessionId,
    timestamp: iso(session.createdAt),
    cwd: session.cwd,
  };
  let parentId: string | null = null;
  const events = rows.map((row, index) => {
    const id = stableId(`${session.id}:${row.id}:${index}`);
    const tool = row.type !== 'user' && row.type !== 'assistant';
    const details: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        if (!metadata || typeof metadata !== 'object') throw new Error('Invalid history metadata');
        for (const field of [
          'toolName',
          'toolUseId',
          'toolInput',
          'toolResult',
          'isError',
          'answers',
          'attachments',
          'images',
        ]) {
          if (metadata[field] !== undefined) details[field] = metadata[field];
        }
      } catch {
        details.unparsedMetadata = row.metadata;
      }
    }
    const content = [
      row.thinking_content,
      row.content,
      Object.keys(details).length
        ? `[历史附加信息 / Historical details]\n${JSON.stringify(details, null, 2)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const event = {
      type: 'message',
      id,
      parentId,
      timestamp: iso(row.created_at),
      message: {
        role: row.type === 'user' ? 'user' : 'assistant',
        content: [
          {
            type: 'text',
            text: tool
              ? `[历史工具记录 / Historical tool record: ${row.type}]\n${content}`
              : content,
          },
        ],
        ...(row.type !== 'user'
          ? {
              api: 'openai-completions',
              provider: 'history',
              model: 'imported',
              stopReason: 'stop',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }
          : {}),
        timestamp: row.created_at,
      },
    };
    parentId = id;
    return event;
  });
  return [header, ...events].map(event => JSON.stringify(event)).join('\n') + '\n';
}

/** Project an immutable backup into a history-only native import plan. */
export function planLegacyHistory(backup: string): HistoryPlan {
  const root = path.join(backup, 'openclaw', 'state', 'agents');
  const agents: NativeHistory[] = [];
  if (fs.existsSync(root))
    for (const agent of fs.readdirSync(root, { withFileTypes: true })) {
      if (agent.name !== 'main' || !agent.isDirectory()) continue;
      const index = path.join(root, agent.name, 'sessions', 'sessions.json');
      if (!fs.existsSync(index)) continue;
      const source = JSON.parse(fs.readFileSync(index, 'utf8')) as Record<string, NativeEntry>;
      const entries: Record<string, NativeEntry> = {};
      const transcriptFiles: Record<string, string> = {};
      for (const [sourceKey, entry] of Object.entries(source)) {
        const key = canonicalHistoryKey(sourceKey);
        const owner = /^agent:([^:]+):/i.exec(key.trim())?.[1].toLowerCase();
        if (owner && owner !== 'main') continue;
        if (
          !entry ||
          typeof entry.sessionId !== 'string' ||
          !/^[a-zA-Z0-9_-]+$/.test(entry.sessionId)
        )
          throw new Error('Invalid historical native session identity.');
        if (entries[key] && entries[key].sessionId !== entry.sessionId)
          throw new Error('Ambiguous canonical historical session identity.');
        entries[key] = Object.fromEntries(
          HISTORY_FIELDS.filter(field => entry[field] !== undefined).map(field => [
            field,
            entry[field],
          ]),
        ) as NativeEntry;
        transcriptFiles[key] = transcriptFilename(path.dirname(index), entry);
        if (typeof entries[key].spawnedBy === 'string')
          entries[key].spawnedBy = canonicalHistoryKey(entries[key].spawnedBy as string);
      }
      agents.push({ agentId: agent.name, entries, transcriptFiles });
    }
  const byKey = new Map<string, { agent: NativeHistory; entry: NativeEntry }>();
  for (const agent of agents)
    for (const [key, entry] of Object.entries(agent.entries))
      byKey.set(key, { agent, entry });
  const conversations: HistoryConversation[] = [];
  let groups: HistoryPlan['groups'] = [];
  const product = path.join(backup, DB_FILENAME);
  if (!fs.existsSync(product) && agents.some(agent => Object.keys(agent.entries).length))
    throw new Error(
      'The legacy conversation index is missing. Existing history has been preserved.',
    );
  if (fs.existsSync(product)) {
    const db = new Database(product, { readonly: true, fileMustExist: true });
    try {
      const has = (table: string) =>
        !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      groups = has('session_groups')
        ? db.prepare('SELECT id,name FROM session_groups ORDER BY id').all() as HistoryPlan['groups']
        : [];
      const groupIds = new Set(groups.map(group => group.id));
      const rows = db.prepare('SELECT * FROM cowork_sessions ORDER BY created_at, id').all() as {
        id: string;
        title: string;
        pinned?: number;
        group_id?: string;
        agent_id?: string;
        cwd: string;
        created_at: number;
        updated_at: number;
      }[];
      const external = has('cowork_external_sessions')
        ? (db.prepare('SELECT * FROM cowork_external_sessions').all() as {
            cowork_session_id: string;
            source: string;
            external_session_key: string;
            openclaw_session_key: string | null;
            openclaw_session_id?: string | null;
          }[])
        : [];
      for (const row of rows) {
        const originalAgentId = row.agent_id || 'main';
        if (originalAgentId !== 'main') continue;
        const mapping = external.find(entry => entry.cowork_session_id === row.id);
        const agentId = originalAgentId;
        const originalKey =
          mapping?.openclaw_session_key || buildManagedSessionKey(row.id, agentId);
        let sessionKey = canonicalHistoryKey(originalKey);
        const keyOwner = /^agent:([^:]+):/i.exec(sessionKey.trim())?.[1].toLowerCase();
        if (keyOwner && keyOwner !== 'main') continue;
        let match = byKey.get(sessionKey);
        if (!match && mapping?.openclaw_session_id) {
          const candidates = [...byKey].flatMap(([key, entry]) =>
            entry.agent.agentId === agentId && entry.entry.sessionId === mapping.openclaw_session_id
              ? [{ key, ...entry }]
              : [],
          );
          if (candidates.length > 1) throw new Error('Ambiguous external history identity.');
          if (candidates.length === 1) {
            match = candidates[0];
            sessionKey = candidates[0].key;
          }
        }
        if (
          match &&
          (match.agent.agentId !== agentId ||
            (mapping?.openclaw_session_id && mapping.openclaw_session_id !== match.entry.sessionId))
        )
          throw new Error('Product and native historical identities disagree.');
        const cached = has('cowork_messages')
          ? !!db.prepare('SELECT 1 FROM cowork_messages WHERE session_id=? LIMIT 1').get(row.id)
          : false;
        const body =
          match &&
          fs.existsSync(
            path.join(
              root,
              match.agent.agentId,
              'sessions',
              match.agent.transcriptFiles[sessionKey],
            ),
          );
        conversations.push({
          id: row.id,
          title: row.title,
          pinned: row.pinned === 1,
          groupId: typeof row.group_id === 'string' && groupIds.has(row.group_id) ? row.group_id : null,
          agentId,
          cwd: typeof row.cwd === 'string' ? row.cwd : '',
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          sessionKey,
          nativeSessionId: match?.entry.sessionId ?? stableId(`history:${row.id}`),
          originalBinding: {
            agentId: originalAgentId,
            sessionKey: originalKey,
            nativeSessionId: mapping?.openclaw_session_id ?? match?.entry.sessionId ?? null,
          },
          availability: body ? 'native' : cached ? 'cache' : 'missing',
          ...(mapping
            ? {
                external: {
                  source: mapping.source,
                  key: mapping.external_session_key,
                  sessionKey: mapping.openclaw_session_key,
                  sessionId: mapping.openclaw_session_id ?? null,
                },
              }
            : {}),
        });
      }
    } finally {
      db.close();
    }
  }
  let missingTranscripts = 0;
  for (const agent of agents)
    for (const key of Object.keys(agent.entries))
      if (!fs.existsSync(path.join(root, agent.agentId, 'sessions', agent.transcriptFiles[key])))
        missingTranscripts++;
  return {
    version: 1,
    agents,
    groups,
    conversations,
    summary: {
      conversations: conversations.length,
      cachedConversations: conversations.filter(row => row.availability === 'cache').length,
      unavailableConversations: conversations.filter(row => row.availability === 'missing').length,
      nativeSessions: agents.reduce((sum, agent) => sum + Object.keys(agent.entries).length, 0),
      missingTranscripts,
    },
  };
}

export function stageLegacyHistory(backup: string, targetState: string, plan: HistoryPlan): void {
  const agents = new Map(plan.agents.map(agent => [agent.agentId, structuredClone(agent.entries)]));
  for (const conversation of plan.conversations) {
    if (
      conversation.availability === 'native' ||
      agents.get(conversation.agentId)?.[conversation.sessionKey]
    )
      continue;
    if (!agents.has(conversation.agentId)) agents.set(conversation.agentId, {});
    agents.get(conversation.agentId)![conversation.sessionKey] = {
      sessionId: conversation.nativeSessionId,
      updatedAt: conversation.updatedAt,
    };
  }
  for (const [agentId, entries] of agents) {
    const folder = ownedPath(targetState, path.join('agents', agentId, 'sessions'));
    fs.mkdirSync(folder, { recursive: true });
    for (const [key, entry] of Object.entries(entries)) {
      const filename =
        plan.agents.find(agent => agent.agentId === agentId)?.transcriptFiles[key] ??
        `${entry.sessionId}.jsonl`;
      entry.sessionFile = ownedPath(folder, filename);
      // The old absolute pointer is never followed; immutable transcript bytes stay intact.
      const sourceFolder = path.join(backup, 'openclaw', 'state', 'agents', agentId, 'sessions');
      if (fs.existsSync(sourceFolder)) {
        for (const file of fs.readdirSync(sourceFolder)) {
          if (
            (file === `${entry.sessionId}.jsonl` || file.startsWith(`${entry.sessionId}.`)) &&
            file.endsWith('.jsonl') &&
            !file.endsWith('.trajectory.jsonl')
          )
            fs.copyFileSync(path.join(sourceFolder, file), path.join(folder, file));
        }
        if (filename && fs.existsSync(ownedPath(sourceFolder, filename)))
          fs.copyFileSync(ownedPath(sourceFolder, filename), entry.sessionFile as string);
      }
      if (entry.compactionCheckpoints !== undefined) {
        if (!Array.isArray(entry.compactionCheckpoints))
          throw new Error('Invalid compaction history.');
        for (const checkpoint of entry.compactionCheckpoints as Record<string, unknown>[]) {
          for (const kind of ['preCompaction', 'postCompaction']) {
            const reference = checkpoint[kind] as Record<string, unknown> | undefined;
            if (!reference || typeof reference !== 'object')
              throw new Error('Invalid compaction history reference.');
            if (reference.sessionFile === undefined) continue;
            if (typeof reference.sessionFile !== 'string')
              throw new Error('Invalid compaction transcript path.');
            const filename = path.win32.basename(reference.sessionFile.replaceAll('/', '\\'));
            if (!isTranscriptFilename(filename))
              throw new Error('Invalid compaction transcript filename.');
            const source = path.join(sourceFolder, filename);
            reference.sessionFile = path.join(folder, filename);
            if (fs.existsSync(source)) fs.copyFileSync(source, reference.sessionFile as string);
          }
        }
      }
      const conversation = plan.conversations.find(row => row.sessionKey === key);
      if (conversation?.availability === 'cache') {
        const db = new Database(path.join(backup, DB_FILENAME), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const columns = db.pragma('table_info(cowork_messages)') as { name: string }[];
          const order = columns.some(column => column.name === 'sequence')
            ? 'COALESCE(sequence, created_at), created_at, id'
            : 'created_at, id';
          const rows = db
            .prepare(`SELECT * FROM cowork_messages WHERE session_id=? ORDER BY ${order}`)
            .all(conversation.id) as LegacyMessage[];
          fs.writeFileSync(entry.sessionFile as string, convertCachedHistory(conversation, rows), {
            encoding: 'utf8',
            mode: 0o600,
          });
        } finally {
          db.close();
        }
      }
    }
    writeStartupJson(path.join(folder, 'sessions.json'), entries);
  }
  const media = path.join(backup, 'openclaw', 'state', 'media');
  if (fs.existsSync(media)) fs.cpSync(media, path.join(targetState, 'media'), { recursive: true });
}

/** Target schema is already new. Only history metadata and exact bindings enter it. */
export function restoreHistoryMetadata(
  db: Database.Database,
  plan: HistoryPlan,
  transactionId: string,
): void {
  const synchronous = db.pragma('synchronous', { simple: true }) as number;
  // The next fsynced journal phase must not outlive titles/bindings after power
  // loss. Keep the stronger barrier local to this one migration transaction.
  db.pragma('synchronous=FULL');
  try {
    restoreHistoryMetadataRows(db, plan, transactionId);
    // An empty history has no INSERT to sync. Also flush preceding schema/default
    // writes so a Complete generation cannot outlive its newly prepared database.
    const [checkpoint] = db.pragma('wal_checkpoint(FULL)') as {
      busy: number;
      log: number;
      checkpointed: number;
    }[];
    if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed)
      throw new Error('The restored history database could not be durably checkpointed.');
  } finally {
    db.pragma(`synchronous=${synchronous}`);
  }
}

function restoreHistoryMetadataRows(
  db: Database.Database,
  plan: HistoryPlan,
  transactionId: string,
): void {
  db.transaction(() => {
    const insertGroup = db.prepare(`INSERT INTO session_groups (id,name,created_at)
      VALUES (?,?,?) ON CONFLICT(id) DO NOTHING`);
    const findGroup = db.prepare('SELECT name FROM session_groups WHERE id=?');
    const restoredAt = Date.now();
    for (const group of plan.groups) {
      insertGroup.run(group.id, group.name, restoredAt);
      const restored = findGroup.get(group.id) as { name: string } | undefined;
      if (restored?.name !== group.name)
        throw new Error('Restored history group conflicts with the import plan.');
    }
    const insert = db.prepare(`INSERT INTO cowork_sessions
      (id,title,status,pinned,group_id,cwd,execution_mode,permission_mode,active_skill_ids,agent_id,created_at,updated_at)
      VALUES (?,?,'idle',?,?,?,'local',?,'[]',?,?,?) ON CONFLICT(id) DO NOTHING`);
    const binding = db.prepare(`INSERT INTO history_session_bindings
      (session_id,session_key,native_session_id,availability,source,external_key,transaction_id,
        source_agent_id,source_session_key,source_native_session_id,defaults_applied)
      VALUES (?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(session_id) DO NOTHING`);
    for (const row of plan.conversations) {
      if (row.agentId !== 'main') throw new Error('Only main legacy history can be restored.');
      insert.run(
        row.id,
        row.title,
        row.pinned ? 1 : 0,
        row.groupId,
        row.cwd,
        DEFAULT_PERMISSION_MODE,
        row.agentId,
        row.createdAt,
        row.updatedAt,
      );
      binding.run(
        row.id,
        row.sessionKey,
        row.nativeSessionId,
        row.availability,
        row.external?.source ?? null,
        row.external?.key ?? null,
        transactionId,
        row.originalBinding.agentId,
        row.originalBinding.sessionKey,
        row.originalBinding.nativeSessionId,
      );
      const restored = db
        .prepare(
          `SELECT s.title,s.pinned,s.group_id,s.agent_id,s.cwd,s.created_at,s.updated_at,
        h.session_key,h.native_session_id,h.transaction_id FROM cowork_sessions s
        JOIN history_session_bindings h ON h.session_id=s.id WHERE s.id=?`,
        )
        .get(row.id) as {
        title: string;
        pinned: number;
        group_id: string | null;
        agent_id: string;
        cwd: string;
        created_at: number;
        updated_at: number;
        session_key: string;
        native_session_id: string;
        transaction_id: string;
      };
      if (
        !restored ||
        restored.title !== row.title ||
        restored.pinned !== (row.pinned ? 1 : 0) ||
        restored.group_id !== row.groupId ||
        restored.agent_id !== row.agentId ||
        restored.cwd !== row.cwd ||
        restored.created_at !== row.createdAt ||
        restored.updated_at !== row.updatedAt ||
        restored.session_key !== row.sessionKey ||
        restored.native_session_id !== row.nativeSessionId ||
        restored.transaction_id !== transactionId
      )
        throw new Error('Restored history metadata conflicts with the import receipt.');
    }
  })();
}

/** Resume checks receipts without overwriting any current product metadata. */
export function verifyRestoredHistoryBindings(
  db: Database.Database,
  plan: HistoryPlan,
  transactionId: string,
): void {
  const lookup = db.prepare(`SELECT s.agent_id,h.session_key,h.native_session_id,h.transaction_id
    FROM cowork_sessions s JOIN history_session_bindings h ON h.session_id=s.id WHERE s.id=?`);
  for (const row of plan.conversations) {
    const restored = lookup.get(row.id) as
      | {
          agent_id: string;
          session_key: string;
          native_session_id: string;
          transaction_id: string;
        }
      | undefined;
    if (
      !restored ||
      restored.agent_id !== row.agentId ||
      restored.session_key !== row.sessionKey ||
      restored.native_session_id !== row.nativeSessionId ||
      restored.transaction_id !== transactionId
    )
      throw new Error('A restored historical conversation binding is missing or changed.');
  }
}
