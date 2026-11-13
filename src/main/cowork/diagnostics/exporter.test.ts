import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';

import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { buildDiagnosticArchive, writeDiagnosticArchive } from './exporter';
import { DiagnosticExportLogs } from './exportLogs';
import { collectDiagnosticLogs } from './logCollector';

const report = (): DiagnosticReport => ({
  version: 1,
  snapshotId: 'snapshot',
  sessionId: 'SECRET-session',
  collectedAt: 10,
  run: { id: 'SECRET-run', startedAt: 1, state: 'running' },
  conclusion: {
    reason: 'unknown',
    confidence: 'unknown',
    evidenceIds: ['SECRET-event'],
    toolFailures: 0,
  },
  coverage: { dropped: 0, storageFailed: false, partial: true },
  connection: 'offline',
  environment: { status: 'not_requested' },
  events: [
    {
      id: 'SECRET-event',
      runId: 'SECRET-run',
      nativeRunId: 'SECRET-native',
      generation: 'SECRET-generation',
      epoch: 'SECRET-epoch',
      observedAt: 2,
      kind: 'lifecycle',
      phase: 'start',
    },
  ],
});

it.each(['en', 'zh'] as const)(
  'exports the tool timeout phase and caution in %s without creating retry authorization',
  language => {
    const input = report();
    Object.assign(input.run!, { state: 'failed', endedAt: 3 });
    Object.assign(input.conclusion, { reason: 'timeout', confidence: 'confirmed' });
    Object.assign(input.events[0], {
      phase: 'error',
      executionSettled: true,
      stopReason: 'timeout',
      timeoutPhase: 'tool_execution',
    });
    const entries = buildDiagnosticArchive(input, '1.0.0', language);
    expect(JSON.parse(entries['report.json']).events[0].timeoutPhase).toBe('tool_execution');
    expect(entries['summary.md']).toContain(
      language === 'en'
        ? 'executing tools; verify their state before repeating them'
        : '工具执行；重复操作前请核对实际状态',
    );
    Object.assign(input.events[0], { timeoutPhase: 'PRIVATE_UNKNOWN_PHASE' });
    const unknown = buildDiagnosticArchive(input, '1.0.0', language);
    expect(JSON.parse(unknown['report.json']).events[0].timeoutPhase).toBe('unknown');
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE_UNKNOWN_PHASE');
  },
);

it('exports a bounded replay rejection observation without changing settlement or inventing a site', () => {
  const input = report();
  input.events[0].phase = 'error';
  input.events[0].runtimeFailure = 'replay_admission_rejected';
  input.history = {
    status: 'scanned',
    messagesScanned: 1,
    omitted: 0,
    failures: [
      {
        kind: 'runtime',
        basis: 'failure_receipt',
        cause: 'replay_admission_rejected',
        association: 'run_window',
        timestamp: 2,
        excerpt: 'Persisted user turn changed before replay admission',
        clipped: false,
      },
    ],
  };
  const entries = buildDiagnosticArchive(input, '1.0.0', 'en');
  const data = JSON.parse(entries['report.json']);
  expect(data.events[0].runtimeFailure).toBe('replay_admission_rejected');
  expect(data.events[0].executionSettled).toBeUndefined();
  expect(data.events[0]).not.toHaveProperty('site');
  expect(data.history.failures[0]).toMatchObject({
    cause: 'replay_admission_rejected',
    association: 'run_window',
  });
  expect(entries['summary.md']).toContain('does not distinguish the three internal checks');
  expect(entries['summary.md']).toContain('does not establish whole-run settlement');
  Object.assign(input.events[0], { runtimeFailure: 'PRIVATE_RAW_TEXT' });
  Object.assign(input.history.failures[0], { cause: 'PRIVATE_RAW_TEXT' });
  const invalid = buildDiagnosticArchive(input, '1.0.0', 'en');
  expect(JSON.parse(invalid['report.json']).events[0].runtimeFailure).toBeUndefined();
  expect(JSON.stringify(invalid)).not.toContain('PRIVATE_RAW_TEXT');
});

it('exports current runtime identity and artifact fingerprints without claiming historical provenance', () => {
  const input = report();
  input.runtimeInfo = {
    scope: 'collection_environment',
    collectedAt: 10,
    wireVersion: 'v2026.10.6',
    gateway: { status: 'connected', version: '2026.10.4', protocol: 3, buildId: 'abc1234' },
    installedArtifact: { version: 'v2026.10.5', patchSetSha256: 'a'.repeat(64) },
  };
  Object.assign(input.runtimeInfo.gateway, { token: 'PRIVATE' });
  Object.assign(input.runtimeInfo.installedArtifact!, { path: 'PRIVATE' });
  const archive = buildDiagnosticArchive(input, '2026.8.27', 'en');
  const data = JSON.parse(archive['report.json']);
  expect(data.runtimeInfo.gateway.version).toBe('2026.10.4');
  expect(data.runtimeInfo).toMatchObject({
    scope: 'collection_environment',
    installedArtifact: { version: 'v2026.10.5', patchSetSha256: 'a'.repeat(64) },
  });
  expect(JSON.stringify(archive)).not.toContain('PRIVATE');
  input.runtimeInfo.gateway = { status: 'offline', version: '2026.10.4' };
  expect(
    JSON.parse(buildDiagnosticArchive(input, '2026.8.27', 'en')['report.json']).runtimeInfo.gateway,
  ).toEqual({ status: 'offline' });
  input.runtimeInfo.gateway = { status: 'connected', version: 'PRIVATE', buildId: 'PRIVATE' };
  input.runtimeInfo.installedArtifact = { patchSetSha256: 'PRIVATE' };
  expect(JSON.stringify(buildDiagnosticArchive(input, '2026.8.27', 'en'))).not.toContain('PRIVATE');
});

it('exports only response shape and aliased stop evidence, never model text', () => {
  const input = report();
  input.run!.state = 'completed';
  input.history = {
    status: 'scanned',
    messagesScanned: 1,
    omitted: 0,
    failures: [],
    lastResponse: {
      timestamp: 2,
      association: 'run',
      thinking: true,
      text: false,
      toolCall: false,
      other: false,
      complete: true,
      stopReason: 'max_tokens',
    },
  };
  Object.assign(input.history.lastResponse!, { rawThinking: 'SECRET' });
  const archive = buildDiagnosticArchive(input, '2026.9.1', 'zh');
  expect(JSON.parse(archive['report.json']).stopAssessment).toMatchObject({
    reason: 'reasoning_only',
    basis: 'history',
    outputLimited: true,
  });
  expect(JSON.parse(archive['report.json']).history.lastResponse).toMatchObject({
    thinking: true,
    text: false,
  });
  expect(JSON.stringify(archive)).not.toContain('SECRET');
});

it('exports native settlement without inventing a loop branch or response observation', () => {
  const input = report();
  input.conclusion = {
    reason: 'completed',
    confidence: 'confirmed',
    evidenceIds: ['SECRET-event'],
    toolFailures: 0,
  };
  Object.assign(input.events[0], {
    phase: 'end',
    executionSettled: true,
    stopReason: 'stop',
  });
  const archive = buildDiagnosticArchive(input, '2026.9.8', 'zh');
  const exported = JSON.parse(archive['report.json']);
  expect(exported.stopAssessment).toMatchObject({ reason: 'completed', basis: 'terminal' });
  expect(exported.events[0]).toMatchObject({ executionSettled: true, stopReason: 'stop' });
  expect(exported.stopAssessment).not.toHaveProperty('loopExit');
  expect(exported.events[0]).not.toHaveProperty('responseShape');
  Object.assign(input.events[0], { loopExit: 'SECRET', responseShape: 'SECRET' });
  expect(JSON.stringify(buildDiagnosticArchive(input, '2026.9.8', 'zh'))).not.toContain('SECRET');
});

it('exports native conversation failure excerpts with coverage and credential masking', () => {
  const input = report();
  input.history = {
    status: 'partial',
    reason: 'page_limit',
    messagesScanned: 200,
    omitted: 3,
    failures: [
      {
        timestamp: 2,
        kind: 'tool',
        tool: 'exec',
        excerpt: 'ENOENT: missing file; password=private-value',
        clipped: false,
        association: 'run_window',
        basis: 'activity',
        outcome: 'blocked',
      },
    ],
  };
  const archive = buildDiagnosticArchive(input, '2026.9.1', 'zh');
  const data = JSON.parse(archive['report.json']);
  expect(data.history.failures[0].excerpt).toContain('ENOENT');
  expect(archive['report.json']).not.toContain('private-value');
  expect(data.history).toMatchObject({
    reason: 'page_limit',
    failures: [{ basis: 'activity', outcome: 'blocked' }],
  });
  expect(data.archive.conversationFailureExcerptsIncluded).toBe(true);
  expect(archive['summary.md']).toContain('report.json → history.failures[0]');
});

async function readZip(file: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const entries: Record<string, string> = {};
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zip.close();
            reject(streamError);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
          stream.on('error', reject);
          stream.on('end', () => {
            entries[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

describe('diagnostic archive', () => {
  it('maps structured evidence aliases to the exported log text without inserted headers', async () => {
    const input = report();
    const directory = await temporary();
    const main = path.join(directory, 'main.log');
    const gateway = path.join(directory, 'gateway.log');
    const ready = '[1970-01-01T00:00:00.003Z] [stderr] [gateway] ready';
    const fatal =
      '[1970-01-01T00:00:00.004Z] [stderr] 00:00:00.004 [gateway/server] startup failed';
    const gatewayFrame = '[1970-01-01T00:00:00.004Z] [stderr]     at run (gateway.js:1:2)';
    const warning = '[1970-01-01T00:00:00.005Z] [warn] A warning for context';
    const exhausted =
      '[1970-01-01T00:00:00.005Z] [warn] empty response retries exhausted: retry limit';
    const error = '[1970-01-01T00:00:00.007Z] [error] Error: ECONNRESET\n  at worker.js:12';
    const native = JSON.stringify({
      time: '1970-01-01T00:00:00.006Z',
      runId: input.run!.id,
      level: 'info',
      type: 'model.call.error',
    });
    await fs.writeFile(
      main,
      `${warning}\n${exhausted}\n${error}\npassword=PRIVATE_TEST_PASSWORD\n`,
    );
    await fs.writeFile(gateway, `${ready}\n${fatal}\n${gatewayFrame}\n`);
    const capture = new DiagnosticExportLogs();
    input.logs = await collectDiagnosticLogs(
      input,
      { main: [main], cowork: [], gateway: [gateway] },
      { lines: [native] },
      {
        fullScan: true,
        onExportRecord: (source, text, association, details) =>
          capture.append(source, text, association, details),
      },
    );
    const destination = path.join(directory, 'log-lines.zip');
    await writeDiagnosticArchive(
      destination,
      buildDiagnosticArchive(input, '1.0.0', 'en', capture.finish()),
      () => {},
    );
    const archive = await readZip(destination);
    const data = JSON.parse(archive['report.json']);
    expect(Object.keys(archive).sort()).toEqual([
      'errors.log',
      'logs/gateway.log',
      'logs/main.log',
      'report.json',
      'summary.md',
    ]);
    expect(archive['logs/main.log']).toBe(`${warning}\n`);
    expect(archive['logs/gateway.log']).toBe(`${ready}\n`);
    expect(archive['errors.log'].split('\n').slice(0, 6).join('\n')).toBe(
      `${fatal}\n${gatewayFrame}\n${exhausted}\n${native}\n${error}`,
    );
    expect(archive['errors.log']).not.toContain('PRIVATE_TEST_PASSWORD');
    expect(data.archive.errorLog).toEqual({
      file: 'errors.log',
      records: 5,
      ranges: [
        { source: 'gateway', association: 'time_window', line: 1, endLine: 2 },
        { source: 'main', association: 'time_window', line: 3, endLine: 3 },
        { source: 'native', association: 'run', line: 4, endLine: 4 },
        { source: 'main', association: 'time_window', line: 5, endLine: 7 },
      ],
    });
    expect(archive['summary.md']).toContain(
      '## Issues and log clues\n\nerrors.log contains 5 retained error log records.',
    );
    expect(data.logs.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'gateway',
          association: 'time_window',
          location: { file: 'errors.log', line: 1, endLine: 1 },
        }),
        expect.objectContaining({
          source: 'main',
          level: 'warn',
          location: { file: 'logs/main.log', line: 1, endLine: 1 },
        }),
        expect.objectContaining({
          source: 'native',
          level: 'info',
          association: 'run',
          location: { file: 'errors.log', line: 4, endLine: 4 },
        }),
        expect.objectContaining({
          source: 'main',
          level: 'error',
          association: 'time_window',
          location: { file: 'errors.log', line: 5, endLine: 7 },
        }),
      ]),
    );
    const noText = JSON.parse(buildDiagnosticArchive(input, '1.0.0', 'en')['report.json']);
    expect(noText.logs.records[0]).not.toHaveProperty('location');
    expect(noText.archive).not.toHaveProperty('errorLog');
  });

  it('keeps four full source budgets and structured evidence inside the archive budget', () => {
    const input = report();
    input.events = Array.from({ length: 232 }, (_, index) => ({
      ...input.events[0],
      id: `event-${index}`,
      nativeRunId: `native-${index}`,
      observedAt: index,
      phase: 'error' as const,
      errorCategory: 'network' as const,
      errorCode: 'ECONNRESET' as const,
    }));
    input.logs = {
      collectedAt: 10,
      window: { from: 0, to: 10 },
      localTimezoneOffsetMinutes: 0,
      partial: true,
      sources: [],
      records: Array.from({ length: 400 }, (_, index) => ({
        id: `log-main-${index + 1}`,
        source: 'main' as const,
        timestamp: index,
        level: 'error' as const,
        association: 'run' as const,
        signal: 'network' as const,
        inferred: true,
        metrics: {
          statusCode: 503,
          attempt: 999,
          durationMs: 999999999999,
          requestPayloadBytes: 999999999999,
          responseStreamBytes: 999999999999,
        },
      })),
    };
    input.history = {
      status: 'scanned',
      messagesScanned: 10000,
      omitted: 100,
      failures: Array.from({ length: 40 }, (_, index) => ({
        timestamp: index,
        kind: 'tool' as const,
        tool: 'x'.repeat(100),
        excerpt: 'x'.repeat(1600),
        clipped: true,
        association: 'run' as const,
      })),
    };
    const capture = new DiagnosticExportLogs();
    const sources = ['main', 'cowork', 'gateway', 'native'] as const;
    for (const [sourceOrder, source] of sources.entries()) {
      for (let index = 1; index <= 2048; index++) {
        const id = `log-${source}-${10000000 + index}`;
        capture.append(source, 'x'.repeat(1023), 'run', {
          id,
          timestamp: Date.parse('2026-10-22T04:00:00Z') + index * sources.length + sourceOrder,
          level: 'error',
        });
      }
    }
    const bundle = capture.finish();
    expect(
      bundle.coverage.every(source => source.bytes === 2 * 1024 * 1024 && source.records === 2048),
    ).toBe(true);
    const archive = buildDiagnosticArchive(input, '2026.10.22', 'en', bundle);
    expect(Buffer.byteLength(archive['errors.log'])).toBe(8 * 1024 * 1024);
    const data = JSON.parse(archive['report.json']);
    expect(data.archive.errorLog.records).toBe(8192);
    expect(data.archive.errorLog.ranges).toHaveLength(8192);
    expect(data.archive.errorLog.ranges.at(-1)).toEqual({
      source: 'native',
      association: 'run',
      line: 8192,
      endLine: 8192,
    });
    expect(data.logs.records.some((record: { location?: unknown }) => record.location)).toBe(false);
    const bytes = Object.values(archive).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    expect(bytes).toBeLessThan(10 * 1024 * 1024);
  });

  it('attributes error text omitted from the bounded structured projection', async () => {
    const input = report();
    const directory = await temporary();
    const main = path.join(directory, 'main.log');
    const first = '[1970-01-01T00:00:00.001Z] [error] Earliest error';
    const later = Array.from(
      { length: 100 },
      (_, index) => `[1970-01-01T00:00:00.002Z] [error] Later error ${index + 1}`,
    );
    await fs.writeFile(main, [first, ...later].join('\n'));
    const capture = new DiagnosticExportLogs();
    input.logs = await collectDiagnosticLogs(
      input,
      { main: [main], cowork: [], gateway: [] },
      undefined,
      {
        fullScan: true,
        onExportRecord: (source, body, association, details) =>
          capture.append(source, body, association, details),
      },
    );
    const entries = buildDiagnosticArchive(input, '1.0.0', 'zh', capture.finish());
    const data = JSON.parse(entries['report.json']);
    expect(data.logs.records).toHaveLength(100);
    expect(data.logs.records).not.toContainEqual(
      expect.objectContaining({ location: { file: 'errors.log', line: 1, endLine: 1 } }),
    );
    expect(entries['errors.log']).toContain(`${first}\n`);
    expect(data.archive.errorLog).toEqual({
      file: 'errors.log',
      records: 101,
      ranges: [{ source: 'main', association: 'time_window', line: 1, endLine: 101 }],
    });
    expect(entries['summary.md']).toContain('errors.log 保留了 101 条错误日志');
  });

  it('exports problem findings with references to the same aliased evidence', () => {
    const input = report();
    input.events[0].phase = 'error';
    input.events[0].errorCategory = 'rate_limit';
    const entries = buildDiagnosticArchive(input, '1.0.0', 'en');
    const data = JSON.parse(entries['report.json']);
    expect(data.findings).toEqual([
      { signal: 'rate_limit', association: 'event', evidence: [data.events[0].id] },
    ]);
    expect(entries['report.json']).not.toContain('SECRET');
  });
  const directories: string[] = [];
  const temporary = async () => {
    const value = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-test-'));
    directories.push(value);
    return value;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('exports native command metadata but rejects invalid numeric values', () => {
    const input = report();
    Object.assign(input.events[0], {
      kind: 'command',
      phase: 'failed',
      exitCode: 127,
      durationMs: 2.5,
    });
    let projected = JSON.parse(buildDiagnosticArchive(input, '2026.8.27', 'en')['report.json']);
    expect(projected.events[0]).toMatchObject({ kind: 'command', exitCode: 127, durationMs: 2.5 });
    Object.assign(input.events[0], { exitCode: 1.5, statusCode: 999, durationMs: -1 });
    projected = JSON.parse(buildDiagnosticArchive(input, '2026.8.27', 'en')['report.json']);
    expect(projected.events[0]).not.toHaveProperty('exitCode');
    expect(projected.events[0]).not.toHaveProperty('statusCode');
    expect(projected.events[0]).not.toHaveProperty('durationMs');
  });

  it('aliases identities consistently and excludes malicious enum and unknown fields', () => {
    const input = report();
    Object.assign(input.events[0], {
      operation: 'SECRET-operation',
      errorCode: 'SECRET-code',
      statusCode: 999,
      durationMs: -1,
      stopReason: 'SECRET-stop',
      errorCategory: 'SECRET-error',
      error: 'SECRET-body',
      payload: { password: 'SECRET-password' },
    });
    Object.assign(input.conclusion, { reason: 'SECRET-reason' });
    const entries = buildDiagnosticArchive(input, 'SECRET-version', 'en');
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    const parsed = JSON.parse(entries['report.json']);
    expect(parsed.run.id).toBe(parsed.events[0].run);
    expect(parsed.conclusion.evidence[0]).toBe(parsed.events[0].id);
    expect(parsed.events[0]).not.toHaveProperty('executionSettled');
    expect(parsed.events[0]).not.toHaveProperty('providerStarted');
    expect(parsed.events[0]).not.toHaveProperty('userInitiated');
  });

  it('writes readable logs into the real ZIP and describes their scope accurately', async () => {
    const destination = path.join(await temporary(), 'with-logs.zip');
    const bundle = {
      entries: { 'logs/main.log': 'Error: required file missing\n  at worker.js:12\n' },
      coverage: [],
    };
    const entries = buildDiagnosticArchive(report(), '2026.8.27', 'en', bundle);
    await writeDiagnosticArchive(destination, entries, () => {});
    const files = await readZip(destination);
    expect(files['logs/main.log']).toContain('required file missing');
    expect(files['logs/main.log']).toContain('worker.js:12');
    const { archive } = JSON.parse(files['report.json']);
    expect(archive.rawLogsIncluded).toBe(true);
    expect(archive.identifiersAliased).toBe(false);
    expect(Object.keys(files).sort()).toEqual(['logs/main.log', 'report.json', 'summary.md']);
    expect([...archive.files].sort()).toEqual(Object.keys(files).sort());
    expect(files['summary.md']).toContain('review task content before sharing');
  });

  it('writes only the summary and report when no log text was retained', async () => {
    const destination = path.join(await temporary(), '中文 diagnostics.zip');
    const input = report();
    input.history = {
      status: 'unavailable',
      reason: 'offline',
      messagesScanned: 0,
      omitted: 0,
      failures: [],
    };
    const entries = buildDiagnosticArchive(
      input,
      '2026.8.27',
      'zh',
      new DiagnosticExportLogs().finish(),
    );
    await writeDiagnosticArchive(destination, entries, () => {});
    const files = await readZip(destination);
    expect(Object.keys(files).sort()).toEqual(['report.json', 'summary.md']);
    const data = JSON.parse(files['report.json']);
    expect(data.history.status).toBe('unavailable');
    expect(data.archive).toMatchObject({
      formatVersion: 3,
      rawLogsIncluded: false,
      conversationFailureExcerptsIncluded: false,
      exportedLogCoverage: Array.from({ length: 4 }, () => expect.objectContaining({ records: 0 })),
    });
    expect(await fs.readdir(path.dirname(destination))).toEqual(['中文 diagnostics.zip']);
  });

  it('exports reviewed log evidence with coverage and rejects injected free text', async () => {
    const input = report();
    input.logs = {
      collectedAt: 10,
      window: { from: 0, to: 10 },
      localTimezoneOffsetMinutes: -480,
      partial: true,
      sources: [
        {
          source: 'native',
          status: 'partial',
          filesRead: 1,
          bytesRead: 100,
          recordsRead: 1,
          emitted: 1,
          suppressed: 0,
          parseFailures: 0,
          truncated: true,
          reasons: ['limit'],
        },
      ],
      records: [
        {
          id: 'SECRET-log-id',
          source: 'native',
          timestamp: 5,
          level: 'error',
          association: 'time_window',
          signal: 'rate_limit',
          inferred: true,
          basis: 'http_status',
          metrics: { statusCode: 429 },
        },
      ],
    };
    Object.assign(input.logs.records[0], { raw: 'SECRET-raw', path: 'SECRET-file' });
    Object.assign(input.logs.records[0].metrics, { credential: 'SECRET-key' });
    const entries = buildDiagnosticArchive(input, '2026.8.27', 'zh');
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(JSON.parse(entries['report.json']).logs.records[0].metrics).toEqual({ statusCode: 429 });
    expect(JSON.parse(entries['report.json']).logs.records[0].basis).toBe('http_status');
    const invalidMetrics = structuredClone(input);
    Object.assign(invalidMetrics.logs!.records[0].metrics, {
      statusCode: 401.5,
      exitCode: 1.5,
      durationMs: -1,
    });
    expect(
      JSON.parse(buildDiagnosticArchive(invalidMetrics, '2026.8.27', 'zh')['report.json']).logs
        .records[0].metrics,
    ).toEqual({});
    const forged = structuredClone(input);
    Object.assign(forged.logs!.records[0], {
      basis: 'SECRET-basis',
      stage: 'SECRET-stage',
      operation: 'SECRET-operation',
      errorCode: 'SECRET-code',
    });
    expect(JSON.stringify(buildDiagnosticArchive(forged, '2026.8.27', 'zh'))).not.toContain(
      'SECRET',
    );
    expect(JSON.parse(entries['report.json']).logs.sources[0].truncated).toBe(true);
    const destination = path.join(await temporary(), 'evidence.zip');
    await writeDiagnosticArchive(destination, entries, () => {});
    expect(await readZip(destination)).toEqual(entries);
  });

  it('keeps an existing destination untouched if snapshot validation fails before publication', async () => {
    const directory = await temporary();
    const destination = path.join(directory, 'existing.zip');
    await fs.writeFile(destination, 'original');
    await expect(
      writeDiagnosticArchive(destination, buildDiagnosticArchive(report(), '1.0', 'en'), () => {
        throw new Error('expired');
      }),
    ).rejects.toThrow('expired');
    expect(await fs.readFile(destination, 'utf8')).toBe('original');
    expect(await fs.readdir(directory)).toEqual(['existing.zip']);
  });

  it('removes temporary output and preserves an existing target when publication fails', async () => {
    const directory = await temporary();
    const destination = path.join(directory, 'existing.zip');
    await fs.writeFile(destination, 'original');
    vi.spyOn(fs, 'rename').mockRejectedValue(
      Object.assign(new Error('disk unavailable'), { code: 'EACCES' }),
    );
    await expect(
      writeDiagnosticArchive(destination, { 'summary.md': 'safe' }, () => {}),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('original');
    expect(await fs.readdir(directory)).toEqual(['existing.zip']);
  });
});
