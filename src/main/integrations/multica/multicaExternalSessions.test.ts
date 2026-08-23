import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import {
  extractOpenClawSessionId,
  extractOpenClawSessionKey,
  MulticaExternalSessionStore,
  rewriteMulticaAgentSessionArgs,
} from './multicaExternalSessions';

describe('Multica external sessions', () => {
  let db: Database.Database | null = null;

  afterEach(() => db?.close());

  test('rewrites initial and resumed ids to one stable OpenClaw session key', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cowork_external_sessions (
        source TEXT, external_session_key TEXT, cowork_session_id TEXT,
        openclaw_session_id TEXT, openclaw_session_key TEXT, cwd TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (source, external_session_key)
      );
    `);
    const sessions = new Map<string, { id: string }>();
    const coworkStore = {
      createSession: () => {
        const session = { id: `session-${sessions.size + 1}` };
        sessions.set(session.id, session);
        return session;
      },
      updateSession: () => undefined,
    } as unknown as CoworkStore;
    const store = new MulticaExternalSessionStore(db, coworkStore);
    const first = rewriteMulticaAgentSessionArgs(
      ['agent', '--local', '--json', '--session-id', 'multica-123', '--message', 'hi'],
      store,
      'C:\\工作区',
    )!;
    store.updateRun(first.binding, 'completed', 'runtime-session-1');
    const resumed = rewriteMulticaAgentSessionArgs(
      ['agent', '--local', '--json', '--session-id', 'runtime-session-1', '--message', 'again'],
      store,
      'C:\\工作区',
    )!;

    expect(first.binding.coworkSessionId).toBe(resumed.binding.coworkSessionId);
    expect(first.binding.openclawSessionKey).toBe(resumed.binding.openclawSessionKey);
    expect(first.binding.openclawSessionKey).toMatch(/^[a-z0-9:_-]+$/);
    expect(resumed.argv).toContain(first.binding.openclawSessionKey);
  });

  test('canonicalizes an existing mixed-case session key before resuming', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cowork_external_sessions (
        source TEXT, external_session_key TEXT, cowork_session_id TEXT,
        openclaw_session_id TEXT, openclaw_session_key TEXT, cwd TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (source, external_session_key)
      );
      INSERT INTO cowork_external_sessions VALUES (
        'multica', 'multica-existing', 'cowork-existing', 'runtime-existing',
        'agent:main:multica:AbCdEf123', 'C:\\workspace', 'completed', 1, 1
      );
    `);
    const coworkStore = {
      createSession: () => ({ id: 'unexpected' }),
      updateSession: () => undefined,
    } as unknown as CoworkStore;
    const store = new MulticaExternalSessionStore(db, coworkStore);

    const resumed = rewriteMulticaAgentSessionArgs(
      ['agent', '--local', '--json', '--session-id', 'runtime-existing', '--message', 'again'],
      store,
      'C:\\workspace',
    )!;

    expect(resumed.binding.openclawSessionKey).toBe('agent:main:multica:abcdef123');
    expect(resumed.argv).toContain('agent:main:multica:abcdef123');
    expect(
      db
        .prepare(
          `SELECT openclaw_session_key FROM cowork_external_sessions
           WHERE external_session_key = 'multica-existing'`,
        )
        .get(),
    ).toEqual({ openclaw_session_key: 'agent:main:multica:abcdef123' });
  });

  test('extracts a runtime session id from JSON and NDJSON output', () => {
    expect(extractOpenClawSessionId('{"result":{"sessionId":"sid-1"}}')).toBe('sid-1');
    expect(extractOpenClawSessionId('{"type":"delta"}\n{"session_id":"sid-2"}\n')).toBe('sid-2');
    expect(
      extractOpenClawSessionKey(
        '{"meta":{"systemPromptReport":{"sessionKey":"agent:main:recovered"}}}',
      ),
    ).toBe('agent:main:recovered');
  });

  test('lets an unknown runtime id resolve before binding its discovered session key', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cowork_external_sessions (
        source TEXT, external_session_key TEXT, cowork_session_id TEXT,
        openclaw_session_id TEXT, openclaw_session_key TEXT, cwd TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (source, external_session_key)
      );
    `);
    const coworkStore = {
      createSession: () => ({ id: 'recovered-local-session' }),
      updateSession: () => undefined,
    } as unknown as CoworkStore;
    const store = new MulticaExternalSessionStore(db, coworkStore);
    const first = rewriteMulticaAgentSessionArgs(
      ['agent', '--local', '--json', '--session-id', 'unknown-runtime-id', '--message', 'hi'],
      store,
      'C:\\工作区',
    )!;
    expect(first.argv).toContain('--session-id');
    expect(first.binding.openclawSessionKey).toBeNull();

    store.updateRun(first.binding, 'completed', 'unknown-runtime-id', 'agent:main:resolved');
    const resumed = rewriteMulticaAgentSessionArgs(first.argv, store, 'C:\\工作区')!;
    expect(resumed.argv).toContain('--session-key');
    expect(resumed.argv).toContain('agent:main:resolved');
  });
});
