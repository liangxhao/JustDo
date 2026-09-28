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

  it('aliases identities consistently and excludes malicious enum and unknown fields', () => {
    const input = report();
    Object.assign(input.events[0], {
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
          metrics: { statusCode: 429 },
        },
      ],
    };
    Object.assign(input.logs.records[0], { raw: 'SECRET-raw', path: 'SECRET-file' });
    Object.assign(input.logs.records[0].metrics, { credential: 'SECRET-key' });
    const entries = buildDiagnosticArchive(input, '2026.8.27', 'zh');
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(JSON.parse(entries['logs.json']).records[0].metrics).toEqual({ statusCode: 429 });
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
