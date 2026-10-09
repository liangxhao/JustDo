import { appendFileSync, truncateSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { collectDiagnosticLogs } from './logCollector';
import { discoverNativeDiagnosticLogs, scanDiagnosticLog } from './logScanner';

const time = Date.parse('2026-09-28T10:00:00Z');
const report = (): DiagnosticReport => ({
  version: 1,
  snapshotId: 's',
  sessionId: 'session',
  collectedAt: time,
  run: { id: 'run', startedAt: time - 1000, endedAt: time + 1000, state: 'failed' },
  events: [],
  conclusion: { reason: 'unknown', confidence: 'unknown', evidenceIds: [], toolFailures: 0 },
  coverage: { dropped: 0, storageFailed: false, partial: true },
  connection: 'offline',
  environment: { status: 'not_requested' },
});
const errorLine = '[2026-09-28T10:00:00Z] [error] HTTP 503\n';
const empty = () => ({ main: [] as string[], cowork: [] as string[], gateway: [] as string[] });
const dirs: string[] = [];
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-scan-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('complete retained-log scanning', () => {
  it('finds a fault at the start of a 96 MiB busy-day log and reports progress through EOF', async () => {
    const file = path.join(await directory(), 'main.log');
    const handle = await fs.open(file, 'w');
    await handle.write(errorLine);
    const filler = '[2026-09-28T18:00:00Z] [info] ' + 'x'.repeat(32700) + '\n';
    const block = filler.repeat(32);
    for (let index = 0; index < 97; index++) await handle.write(block);
    await handle.close();
    let progresses = 0;
    const logs = await collectDiagnosticLogs(report(), { ...empty(), main: [file] }, undefined, {
      fullScan: true,
      onProgress: () => {
        progresses++;
      },
    });
    expect(logs.records).toHaveLength(1);
    expect(logs.records[0]).toMatchObject({ signal: 'provider', association: 'time_window' });
    expect(logs.sources[0]).toMatchObject({ scanComplete: true, filesCompleted: 1, matched: 1 });
    expect(logs.sources[0].bytesRead).toBe((await fs.stat(file)).size);
    expect(logs.sources[0].bytesRead).toBeGreaterThan(96 * 1024 * 1024);
    expect(progresses).toBeGreaterThan(300);
  }, 30_000);

  it('scans every rotated file and continues counting after preview limits, keeping late errors', async () => {
    const dir = await directory();
    const files: string[] = [];
    for (let index = 0; index < 20; index++) {
      const file = path.join(dir, `main-${index}.log`);
      await fs.writeFile(
        file,
        '[2026-09-28T10:00:00Z] [info] queue\n'.repeat(20) + (index === 19 ? errorLine : ''),
      );
      files.push(file);
    }
    const logs = await collectDiagnosticLogs(report(), { ...empty(), main: files }, undefined, {
      fullScan: true,
    });
    expect(logs.sources[0]).toMatchObject({
      scanComplete: true,
      filesCompleted: 20,
      filesDiscovered: 20,
      matched: 401,
      emitted: 100,
      outputOmitted: 301,
      signalCounts: { queue: 400, provider: 1 },
    });
    expect(logs.sources[0].reasons).toContain('output_limit');
    expect(logs.records.some(record => record.signal === 'provider')).toBe(true);
    expect(new Set(logs.records.map(record => record.id)).size).toBe(logs.records.length);
  });

  it('discovers native daily files only from the authoritative file family and scans old native faults', async () => {
    const dir = await directory();
    const old = path.join(dir, 'openclaw-2026-09-27.log');
    const current = path.join(dir, 'openclaw-2026-09-28.log');
    await fs.writeFile(
      old,
      JSON.stringify({
        time: new Date(time).toISOString(),
        level: 'error',
        errorCategory: 'timeout',
      }) + '\n',
    );
    await fs.writeFile(current, '');
    await fs.writeFile(path.join(dir, 'credentials.json'), 'do not read');
    const files = await discoverNativeDiagnosticLogs(current);
    expect(files).toEqual([old, current]);
    const logs = await collectDiagnosticLogs(
      report(),
      empty(),
      { lines: [], files },
      { fullScan: true },
    );
    expect(logs.sources[3]).toMatchObject({ scanComplete: true, filesCompleted: 2 });
    expect(logs.records[0].signal).toBe('timeout');
  });

  it('cancels between chunks and never labels the partially scanned source complete', async () => {
    const file = path.join(await directory(), 'main.log');
    await fs.writeFile(file, errorLine.repeat(30000));
    const controller = new AbortController();
    const logs = await collectDiagnosticLogs(report(), { ...empty(), main: [file] }, undefined, {
      fullScan: true,
      signal: controller.signal,
      onProgress: progress => {
        if (progress.bytesRead > 0) controller.abort();
      },
    });
    expect(logs.sources[0]).toMatchObject({ scanComplete: false, filesCompleted: 0 });
    expect(logs.sources[0].reasons).toContain('canceled');
    expect(logs.sources[0].bytesRead).toBeLessThan((await fs.stat(file)).size);
  });

  it('handles chunk boundaries, oversized records and UTF-8 without leaking fragments', async () => {
    const file = path.join(await directory(), 'main.log');
    await fs.writeFile(
      file,
      '[2026-09-28T10:00:00Z] [info] ' + '中'.repeat(120000) + '\n' + errorLine,
    );
    const records: string[] = [];
    let oversized = 0;
    await scanDiagnosticLog(file, false, {
      record: text => records.push(text),
      oversized: () => {
        oversized++;
      },
      progress: () => {},
    });
    expect(oversized).toBe(1);
    expect(records).toEqual([errorLine.trim()]);
  });

  it('marks files removed during scanning as a coverage gap', async () => {
    const file = path.join(await directory(), 'main.log');
    await fs.writeFile(file, errorLine);
    const logs = await collectDiagnosticLogs(
      report(),
      { ...empty(), main: [file, file + '.old'] },
      undefined,
      { fullScan: true },
    );
    expect(logs.sources[0]).toMatchObject({
      scanComplete: false,
      filesCompleted: 1,
      filesDiscovered: 2,
    });
    expect(logs.sources[0].reasons).toContain('missing');
  });

  it('stops at the captured file size despite concurrent appends', async () => {
    const file = path.join(await directory(), 'main.log');
    await fs.writeFile(file, errorLine);
    const records: string[] = [];
    let appended = false;
    await scanDiagnosticLog(file, false, {
      record: text => records.push(text),
      oversized: () => {},
      progress: () => {
        if (!appended) {
          appended = true;
          appendFileSync(file, errorLine.repeat(10000));
        }
      },
    });
    expect(records).toEqual([errorLine.trim()]);
  });

  it('reports concurrent truncation instead of declaring the file fully scanned', async () => {
    const file = path.join(await directory(), 'main.log');
    await fs.writeFile(file, errorLine.repeat(10000));
    let truncated = false;
    const logs = await collectDiagnosticLogs(report(), { ...empty(), main: [file] }, undefined, {
      fullScan: true,
      onProgress: () => {
        if (!truncated) {
          truncated = true;
          truncateSync(file, 0);
        }
      },
    });
    expect(logs.sources[0]).toMatchObject({ scanComplete: false, filesCompleted: 0 });
    expect(logs.sources[0].reasons).toContain('source_changed');
  });
});
