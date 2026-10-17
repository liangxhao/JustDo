import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, expect, test } from 'vitest';

// Allow CLI cold starts and up to two independently bounded 10-second child runs.
const script = path.resolve('scripts/openclaw/inspect-session-storage.cjs');
const fixtureRoot = path.resolve('.agent-tasks/session-storage-tests');
const fixtures: Array<{ directory: string; database: DatabaseSync }> = [];

function fixture() {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureRoot, 'inspection-'));
  const databasePath = path.join(directory, 'openclaw-agent.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY, session_key TEXT, previous_session_id TEXT,
      reason TEXT, status TEXT
    );
    CREATE TABLE transcript_events (
      session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT,
      event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE session_transcript_active_events (session_id TEXT, event_seq INTEGER);
    CREATE TABLE session_transcript_index_state (
      session_id TEXT, indexed_seq INTEGER, needs_rebuild INTEGER
    );
    INSERT INTO session_windows VALUES ('native-session', 'agent:main:chat:test', NULL, 'initial', 'failed');
  `);
  fixtures.push({ directory, database });
  return { directory, databasePath, database };
}

function insertEvent(
  database: DatabaseSync,
  seq: number,
  event: unknown,
  compressed = false,
  sessionId = 'native-session',
) {
  const json = JSON.stringify(event);
  database
    .prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      sessionId,
      seq,
      1000 + seq,
      compressed ? null : json,
      compressed ? zstdCompressSync(Buffer.from(json)) : null,
      Buffer.byteLength(json),
    );
  return json;
}

function run(directory: string, databasePath: string, args: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [script, '--db', databasePath, '--session-id', 'native-session', ...args],
    { cwd: directory, encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  const reportPath = result.stdout.match(/^Report: (.+)$/m)?.[1].trim();
  const report = reportPath ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : undefined;
  return { ...result, report };
}

afterEach(() => {
  for (const { directory, database } of fixtures.splice(0)) {
    database.close();
    if (path.dirname(path.resolve(directory)) !== fixtureRoot)
      throw new Error('Unexpected fixture cleanup path.');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reads committed WAL events and compressed original content without changing the database', () => {
  const { directory, database, databasePath } = fixture();
  insertEvent(database, 1, { type: 'session', id: 'native-session' });
  const eventJson = insertEvent(
    database,
    2,
    {
      id: 'assistant-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Provider returned an incomplete or malformed tool call',
        __openclaw: { runId: 'run-1' },
        content: [
          { type: 'thinking', thinking: '先检查环境' },
          { type: 'text', text: '开始处理。' },
          { type: 'toolCall', id: 'tool-1', name: 'exec', partialArgs: '{"command":"unfinished' },
        ],
      },
    },
    true,
  );
  insertEvent(
    database,
    1,
    { type: 'message', message: { role: 'assistant', content: 'other-session-secret' } },
    false,
    'other',
  );
  database.exec(`
    INSERT INTO session_transcript_active_events VALUES ('native-session', 2);
    INSERT INTO session_transcript_index_state VALUES ('native-session', 2, 0);
  `);
  const digest = () => createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
  const before = digest();
  const rowsBefore = database.prepare('SELECT * FROM transcript_events').all();

  const result = run(directory, databasePath, ['--include-content', '--run-id', 'run-1']);

  expect(result.status).toBe(0);
  expect(result.report.coverage).toMatchObject({
    complete: true,
    rowsScanned: 2,
    compressedRows: 1,
    activeIndexReliable: true,
  });
  expect(result.report.exactRunSummary).toMatchObject({
    assistantMessages: 1,
    thinkingChars: 5,
    textChars: 5,
    toolCalls: 1,
    errorMessages: 1,
  });
  expect(result.report.records[1]).toMatchObject({
    eventJson,
    activeBranch: true,
    runMatch: 'exact',
    toolCalls: [{ validJsonObject: false }],
  });
  expect(JSON.stringify(result.report)).not.toContain('other-session-secret');
  expect(result.stdout).not.toContain('先检查环境');
  expect(digest()).toBe(before);
  expect(database.prepare('SELECT * FROM transcript_events').all()).toEqual(rowsBefore);
}, 30_000);

test('keeps unbound and other runs separate and reports stored repetitions with branch membership', () => {
  const { directory, database, databasePath } = fixture();
  for (const [seq, runId] of [
    [1, 'run-1'],
    [2, 'run-1'],
    [3, 'run-2'],
    [4, undefined],
  ] as const) {
    insertEvent(database, seq, {
      type: 'message',
      message: {
        role: 'assistant',
        content: 'same text',
        errorMessage: 'private error detail',
        ...(runId ? { __openclaw: { runId } } : {}),
      },
    });
  }
  database.exec(`
    INSERT INTO session_transcript_active_events VALUES ('native-session', 2);
    INSERT INTO session_transcript_index_state VALUES ('native-session', 4, 1);
  `);

  const result = run(directory, databasePath, ['--run-id', 'run-1']);

  expect(result.status).toBe(0);
  expect(result.report.exactRunSummary.assistantMessages).toBe(2);
  expect(result.report.unboundAssistantMessages).toBe(1);
  expect(result.report.records.map((record: { runMatch: string }) => record.runMatch)).toEqual([
    'exact',
    'exact',
    'other',
    'unbound',
  ]);
  expect(result.report.coverage.activeIndexReliable).toBe(false);
  expect(result.report.repeatedStoredText).toMatchObject([
    {
      runId: 'run-1',
      occurrences: [
        { seq: 1, activeBranch: false },
        { seq: 2, activeBranch: true },
      ],
    },
  ]);
  expect(JSON.stringify(result.report)).not.toContain('same text');
  expect(JSON.stringify(result.report)).not.toContain('private error detail');
}, 30_000);

test('reports unreadable rows and archives as incomplete instead of concluding no content exists', () => {
  const { directory, database, databasePath } = fixture();
  database.exec(`
    CREATE TABLE session_transcript_cold_archives (session_id TEXT, generation TEXT, storage TEXT, event_count INTEGER, archive_bytes INTEGER);
    INSERT INTO session_transcript_cold_archives VALUES ('native-session', 'generation-1', 'file', 10, 900);
    CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, reason TEXT, encoding TEXT, archive_blob BLOB);
    INSERT INTO session_transcript_archives VALUES ('native-session', 'generation-0', 'reset', 'identity', x'0102');
    INSERT INTO transcript_events VALUES ('native-session', 1, 1, 'private broken JSON', NULL, NULL);
    INSERT INTO transcript_events VALUES ('native-session', 2, 2, NULL, x'010203', 50);
  `);

  const result = run(directory, databasePath);

  expect(result.status).toBe(2);
  expect(result.report.coverage).toMatchObject({
    complete: false,
    found: true,
    failures: [{ seq: 1 }, { seq: 2 }],
    coldArchive: { event_count: 10 },
    resetArchives: [{ generation: 'generation-0' }],
  });
  expect(JSON.stringify(result.report)).not.toContain('private broken JSON');
  expect(result.stdout).toContain('Inspection is incomplete');
}, 30_000);

test('a missing session or SQL-like identity does not select any other session', () => {
  const { directory, database, databasePath } = fixture();
  insertEvent(database, 1, {
    type: 'message',
    message: { role: 'assistant', content: 'must not match' },
  });

  const result = run(directory, databasePath, ['--session-id', "' OR 1=1 --"]);

  expect(result.status).toBe(2);
  expect(result.report.coverage).toMatchObject({ found: false, complete: false, rowsScanned: 0 });
  expect(result.report.records).toEqual([]);
}, 30_000);

test('rejects the product database and never creates a database at a missing path', () => {
  const { directory, databasePath } = fixture();
  const productPath = path.join(directory, 'product.sqlite');
  const product = new DatabaseSync(productPath);
  product.exec('CREATE TABLE cowork_sessions (id TEXT);');
  product.close();

  const wrong = run(directory, productPath);
  const missingPath = path.join(directory, 'missing.sqlite');
  const missing = run(directory, missingPath);

  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toContain('Select openclaw-agent.sqlite');
  expect(missing.status).toBe(1);
  expect(fs.existsSync(missingPath)).toBe(false);
  expect(fs.existsSync(databasePath)).toBe(true);
}, 30_000);
