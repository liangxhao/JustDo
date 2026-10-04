import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';

import type { DiagnosticReport } from '../../../shared/cowork/sessionDiagnostics';
import { buildDiagnosticArchive, writeDiagnosticArchive } from './exporter';

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
  expect(JSON.parse(archive['session-evidence.json']).lastResponse).toMatchObject({
    thinking: true,
    text: false,
  });
  expect(JSON.stringify(archive)).not.toContain('SECRET');
});

it('exports the recorded exit branch and closed response kind', () => {
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
    loopExit: 'no_pending_work',
    responseShape: 'text',
  });
  const archive = buildDiagnosticArchive(input, '2026.9.8', 'zh');
  const exported = JSON.parse(archive['report.json']);
  expect(exported.stopAssessment.loopExit).toBe('no_pending_work');
  expect(exported.events[0]).toMatchObject({ loopExit: 'no_pending_work', responseShape: 'text' });
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
  expect(archive['session-evidence.json']).toContain('ENOENT');
  expect(archive['session-evidence.json']).not.toContain('private-value');
  expect(JSON.parse(archive['session-evidence.json'])).toMatchObject({
    reason: 'page_limit',
    failures: [{ basis: 'activity', outcome: 'blocked' }],
  });
  expect(JSON.parse(archive['manifest.json'])).toMatchObject({
    conversationFailureExcerptsIncluded: true,
    files: expect.arrayContaining(['session-evidence.json']),
  });
  expect(archive['summary.md']).toContain('session-evidence.json');
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
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.rawLogsIncluded).toBe(true);
    expect(manifest.identifiersAliased).toBe(false);
    expect(manifest.files).toContain('logs/main.log');
    expect(files['summary.md']).toContain('review task content before sharing');
  });

  it('writes a real ZIP whose extracted files match the safe projection', async () => {
    const destination = path.join(await temporary(), '中文 diagnostics.zip');
    const entries = buildDiagnosticArchive(report(), '2026.8.27', 'zh');
    await writeDiagnosticArchive(destination, entries, () => {});
    expect(await readZip(destination)).toEqual(entries);
    expect(await fs.readdir(path.dirname(destination))).toEqual(['中文 diagnostics.zip']);
  });

  it('exports reviewed log evidence with coverage and an AI guide, rejecting injected free text', async () => {
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
    expect(JSON.parse(entries['logs.json']).records[0].metrics).toEqual({ statusCode: 429 });
    expect(JSON.parse(entries['logs.json']).records[0].basis).toBe('http_status');
    const invalidMetrics = structuredClone(input);
    Object.assign(invalidMetrics.logs!.records[0].metrics, {
      statusCode: 401.5,
      exitCode: 1.5,
      durationMs: -1,
    });
    expect(
      JSON.parse(buildDiagnosticArchive(invalidMetrics, '2026.8.27', 'zh')['logs.json']).records[0]
        .metrics,
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
    expect(JSON.parse(entries['manifest.json']).logCoverage[0].truncated).toBe(true);
    expect(entries['ai-analysis.md']).toContain('executionSettled=true');
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
