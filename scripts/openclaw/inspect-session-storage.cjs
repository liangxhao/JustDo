#!/usr/bin/env node
'use strict';

// Explicit, per-session forensic inspection. Do not import the runtime: opening
// its normal store can prepare schemas or acquire a writer lease.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { zstdDecompressSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const MAX_COMPRESSED_EVENT_BYTES = 4 * 1024 * 1024;
const HELP = `Usage:
  node inspect-session-storage.cjs --db <openclaw-agent.sqlite> --session-id <native-session-id> [--run-id <run-id>] [--include-content]

Requires Node.js 24. Reads only the explicitly selected native SQLite database,
including its committed WAL data. Does not start Gateway, migrate, or repair it.
--run-id highlights exact matches; other and unbound records remain in the report.
--include-content includes the original stored event JSON in the local report.
Reports are written under .agent-tasks/session-storage/ in the current directory.
Cold/reset archive metadata is reported, but archives are not opened or restored.
Persisted native events are not the original provider HTTP/SSE response.
`;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inspectMessage(event, row, active, runId, includeContent) {
  const message = object(event.message) ? event.message : event;
  const blocks = Array.isArray(message.content)
    ? message.content.filter(object)
    : typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : [];
  const storedRunId = text(message.__openclaw?.runId) ?? text(event.details?.runId);
  const contents = [];
  const toolCalls = [];
  blocks.forEach((block, index) => {
    const type = String(block.type ?? '')
      .toLowerCase()
      .replaceAll('_', '');
    if (['text', 'outputtext', 'thinking', 'reasoning', 'redactedthinking'].includes(type)) {
      const value = block.text ?? block.thinking ?? block.reasoning;
      if (typeof value === 'string') {
        contents.push({
          index,
          type: ['thinking', 'reasoning', 'redactedthinking'].includes(type) ? 'thinking' : 'text',
          chars: value.length,
          sha256: hash(value),
        });
      }
    }
    if (['toolcall', 'tooluse', 'functioncall'].includes(type)) {
      const args = block.partialArgs ?? block.arguments ?? block.input ?? block.function?.arguments;
      let validJsonObject = object(args);
      if (typeof args === 'string') {
        try {
          validJsonObject = object(JSON.parse(args));
        } catch {
          validJsonObject = false;
        }
      }
      toolCalls.push({
        id: block.id ?? null,
        name: block.name ?? block.function?.name ?? null,
        argumentType: args === undefined ? 'missing' : typeof args,
        validJsonObject,
      });
    }
  });
  return {
    seq: row.seq,
    eventId: event.id ?? null,
    eventType: event.type ?? null,
    role: message.role ?? null,
    timestamp: event.timestamp ?? message.timestamp ?? row.created_at,
    activeBranch: active === null ? null : active.has(row.seq),
    runId: storedRunId,
    runMatch: !runId ? null : !storedRunId ? 'unbound' : storedRunId === runId ? 'exact' : 'other',
    stopReason: message.stopReason ?? message.stop_reason ?? null,
    errorChars: typeof message.errorMessage === 'string' ? message.errorMessage.length : 0,
    content: contents,
    toolCalls,
    ...(includeContent ? { eventJson: row.event_json } : {}),
  };
}

function inspectDatabase(databasePath, sessionId, runId, includeContent) {
  if (!fs.statSync(databasePath).isFile()) throw new Error('The database path must be a file.');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN;');
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map(row => row.name),
    );
    for (const table of ['session_windows', 'transcript_events']) {
      if (!tables.has(table)) {
        throw new Error(
          `Missing native table ${table}. Select openclaw-agent.sqlite, not the product database.`,
        );
      }
    }
    const columns = new Set(
      database
        .prepare('PRAGMA table_info(transcript_events)')
        .all()
        .map(row => row.name),
    );
    for (const column of [
      'session_id',
      'seq',
      'created_at',
      'event_json',
      'event_zstd',
      'event_utf8_bytes',
    ]) {
      if (!columns.has(column))
        throw new Error(
          `Unsupported native schema: transcript_events.${column} is missing. No migration was attempted.`,
        );
    }
    const window =
      database
        .prepare(
          'SELECT session_id, session_key, previous_session_id, reason, status FROM session_windows WHERE session_id = ?',
        )
        .get(sessionId) ?? null;
    const active = tables.has('session_transcript_active_events')
      ? new Set(
          database
            .prepare('SELECT event_seq FROM session_transcript_active_events WHERE session_id = ?')
            .all(sessionId)
            .map(row => row.event_seq),
        )
      : null;
    const indexState = tables.has('session_transcript_index_state')
      ? (database
          .prepare(
            'SELECT indexed_seq, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?',
          )
          .get(sessionId) ?? null)
      : null;
    const cold = tables.has('session_transcript_cold_archives')
      ? (database
          .prepare(
            'SELECT generation, storage, event_count, archive_bytes FROM session_transcript_cold_archives WHERE session_id = ?',
          )
          .get(sessionId) ?? null)
      : null;
    const resetArchives = tables.has('session_transcript_archives')
      ? database
          .prepare(
            'SELECT generation, reason, encoding, length(archive_blob) AS bytes FROM session_transcript_archives WHERE session_id = ?',
          )
          .all(sessionId)
      : [];
    const records = [];
    const failures = [];
    let rowsScanned = 0;
    let compressedRows = 0;
    let lastStoredSeq = 0;
    for (const source of database
      .prepare(
        'SELECT seq, created_at, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq',
      )
      .iterate(sessionId)) {
      rowsScanned++;
      lastStoredSeq = source.seq;
      try {
        let json = source.event_json;
        if (source.event_zstd !== null) {
          compressedRows++;
          if (
            !Number.isSafeInteger(source.event_utf8_bytes) ||
            source.event_utf8_bytes < 1 ||
            source.event_utf8_bytes > MAX_COMPRESSED_EVENT_BYTES
          )
            throw new Error('Invalid compressed event size.');
          const decoded = zstdDecompressSync(source.event_zstd, {
            maxOutputLength: MAX_COMPRESSED_EVENT_BYTES,
          });
          if (decoded.length !== source.event_utf8_bytes)
            throw new Error('Decompressed event size mismatch.');
          json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
        }
        const event = JSON.parse(json);
        if (!object(event)) throw new Error('Stored event is not a JSON object.');
        records.push(
          inspectMessage(event, { ...source, event_json: json }, active, runId, includeContent),
        );
      } catch {
        // Never print a JSON parser exception: it can contain task text/secrets.
        failures.push({ seq: source.seq, reason: 'Stored event could not be decoded or parsed.' });
      }
    }
    const assistants = records.filter(record => record.role === 'assistant');
    const summarize = values => ({
      assistantMessages: values.length,
      thinkingChars: values.reduce(
        (sum, row) =>
          sum +
          row.content
            .filter(block => block.type === 'thinking')
            .reduce((n, block) => n + block.chars, 0),
        0,
      ),
      textChars: values.reduce(
        (sum, row) =>
          sum +
          row.content
            .filter(block => block.type === 'text')
            .reduce((n, block) => n + block.chars, 0),
        0,
      ),
      toolCalls: values.reduce((sum, row) => sum + row.toolCalls.length, 0),
      errorMessages: values.filter(row => row.errorChars > 0).length,
    });
    const groups = new Map();
    for (const record of assistants) {
      for (const block of record.content.filter(
        value => value.type === 'text' && value.chars > 0,
      )) {
        const key = `${record.runId ?? 'unbound'}:${block.sha256}`;
        const group = groups.get(key) ?? {
          runId: record.runId,
          sha256: block.sha256,
          occurrences: [],
        };
        group.occurrences.push({
          seq: record.seq,
          block: block.index,
          activeBranch: record.activeBranch,
        });
        groups.set(key, group);
      }
    }
    const found = Boolean(window || rowsScanned || cold || resetArchives.length);
    return {
      databasePath,
      nativeSessionId: sessionId,
      requestedRunId: runId ?? null,
      session: window,
      coverage: {
        found,
        complete: found && failures.length === 0 && cold === null && resetArchives.length === 0,
        rowsScanned,
        compressedRows,
        failures,
        coldArchive: cold,
        resetArchives,
        activeIndexReliable:
          active !== null &&
          indexState !== null &&
          indexState.needs_rebuild === 0 &&
          failures.length === 0 &&
          indexState.indexed_seq >= lastStoredSeq,
      },
      summary: summarize(assistants),
      ...(runId
        ? {
            exactRunSummary: summarize(assistants.filter(record => record.runMatch === 'exact')),
            unboundAssistantMessages: assistants.filter(record => record.runMatch === 'unbound')
              .length,
          }
        : {}),
      repeatedStoredText: [...groups.values()].filter(group => group.occurrences.length > 1),
      records,
      notes: [
        'Only stored native events were inspected; provider HTTP/SSE and transient UI buffers are not stored here.',
        'Zero counts describe decoded rows only. Unread archives, missing sessions, or parse failures prevent an absence conclusion.',
        'Repeated text can belong to different attempts or branches; identical text alone does not prove duplicate UI rendering.',
        'Active-branch membership is only a persisted index observation; check activeIndexReliable before interpreting it.',
        ...(includeContent
          ? ['eventJson contains original stored task content. Review before sharing.']
          : []),
      ],
    };
  } finally {
    if (database.isTransaction) database.exec('ROLLBACK;');
    database.close();
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      'session-id': { type: 'string' },
      'run-id': { type: 'string' },
      'include-content': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);
  if (!text(values.db) || !text(values['session-id'])) throw new Error(HELP);
  const report = inspectDatabase(
    path.resolve(values.db),
    values['session-id'],
    values['run-id'],
    values['include-content'],
  );
  const directory = path.resolve('.agent-tasks/session-storage');
  fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, `session-${Date.now()}-${randomUUID()}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    `Found session: ${report.coverage.found}; complete scan: ${report.coverage.complete}`,
  );
  console.log(JSON.stringify(report.summary));
  if (report.exactRunSummary) console.log(`Exact run: ${JSON.stringify(report.exactRunSummary)}`);
  console.table(
    report.records
      .filter(row => row.role === 'assistant')
      .map(row => ({
        seq: row.seq,
        run: row.runMatch ?? row.runId,
        active: row.activeBranch,
        stop: row.stopReason,
        thinking: row.content
          .filter(block => block.type === 'thinking')
          .reduce((sum, block) => sum + block.chars, 0),
        content: row.content
          .filter(block => block.type === 'text')
          .reduce((sum, block) => sum + block.chars, 0),
        tools: row.toolCalls.length,
        error: row.errorChars,
      })),
  );
  console.log(`Report: ${reportPath}`);
  if (!report.coverage.complete) {
    console.log(
      'Inspection is incomplete. Check coverage in the report; zero counts do not prove data was never saved.',
    );
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Inspection failed.');
  process.exitCode = 1;
}
