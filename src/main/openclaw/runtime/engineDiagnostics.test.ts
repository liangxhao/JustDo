import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineFailureContext } from '../../../shared/openclaw/engineDiagnostics';
import * as logScanner from '../../cowork/diagnostics/logScanner';
import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  classifyEngineFailure,
  collectEngineDiagnostics,
  type EngineDiagnosticsDependencies,
} from './engineDiagnostics';

vi.mock('../../core/logger', () => ({ getLogFilePath: vi.fn(), getRecentMainLogEntries: vi.fn() }));

describe('engine failure diagnostics', () => {
  let directory: string;
  const now = Date.now();
  const context: EngineFailureContext = {
    id: 'c40c7546-1848-4f88-a5d7-e736c5be23e3',
    startedAt: now - 300_000,
    failedAt: now - 1000,
    processGeneration: 2,
    status: {
      phase: 'error',
      version: 'test',
      canRetry: true,
      message: 'Gateway failed to become healthy in time.',
    },
  };
  let deps: EngineDiagnosticsDependencies;
  const line = (time: number, text: string, level = 'error') =>
    `[${new Date(time).toISOString()}] [${level}] ${text}\n`;
  const collect = (signal = new AbortController().signal) => collectEngineDiagnostics(deps, signal);
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-diagnostics-'));
    deps = {
      getContext: () => context,
      getMainLogFiles: () => [path.join(directory, 'main.log')],
      getGatewayLogFile: () => path.join(directory, 'gateway.log'),
      getGatewayClient: () => null,
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('finds the concrete startup error before a long health timeout, preserving stacks and masking secrets', async () => {
    await fs.writeFile(
      deps.getMainLogFiles()[0],
      line(now - 400_000, '[OpenClaw] EACCES old unrelated failure') +
        line(now - 290_000, '[OpenClaw] startGateway: preparing runtime', 'info') +
        line(now - 290_000, '[OtherFeature] EACCES unrelated feature') +
        line(now - 1000, '[OpenClaw] failed to become healthy in time'),
    );
    await fs.writeFile(
      deps.getGatewayLogFile(),
      line(
        now - 280_000,
        '[gateway] Error: listen EADDRINUSE: address already in use\n    at listen (gateway.js:23)\nAuthorization: Bearer super-private-key\napi_key=private-model-key',
      ),
    );

    const report = await collect();

    expect(report.evidence.find(e => e.id === report.findings[0])?.category).toBe('port');
    const text = JSON.stringify(report);
    expect(text).toContain('gateway.js:23');
    expect(text).not.toContain('super-private-key');
    expect(text).not.toContain('private-model-key');
    expect(text).not.toContain('old unrelated');
    expect(text).not.toContain('unrelated feature');
    expect(report.evidence.some(e => e.level === 'info')).toBe(true);
    expect(report.coverage.find(c => c.source === 'native')?.issues).toEqual(['offline']);
    expect(report.engineChanged).toBe(false);
  });

  it('reads authenticated native JSON logs without retaining configuration or prompt payloads', async () => {
    const file = path.join(directory, 'openclaw-2026-10-20.log');
    await fs.writeFile(
      file,
      [
        {
          time: new Date(now - 1500).toISOString(),
          _meta: { logLevelName: 'ERROR' },
          message: 'SQLITE_BUSY database is locked',
          config: { token: 'private-config', messages: ['private-task'] },
        },
        {
          time: new Date(now - 1500).toISOString(),
          level: 'info',
          ok: true,
          message: 'EADDRINUSE test completed successfully',
        },
        {
          time: new Date(now - 1500).toISOString(),
          level: 'info',
          config: { message: 'EADDRINUSE private config' },
        },
      ]
        .map(item => JSON.stringify(item))
        .join('\n'),
    );
    const request = vi.fn().mockResolvedValue({ file });
    const client = { request } as unknown as GatewayClientLike;
    deps.getGatewayClient = () => client;

    const report = await collect();

    expect(request).toHaveBeenCalledWith(
      'logs.tail',
      expect.anything(),
      expect.objectContaining({ timeoutMs: 3000 }),
    );
    expect(report.evidence.some(e => e.source === 'native' && e.category === 'storage')).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /private-config|private-task|test completed successfully/,
    );
    expect(report.coverage.find(c => c.source === 'native')?.scannedFiles).toBe(1);
  });

  it.each(['main', 'gateway'] as const)(
    'retains the outer timestamp for %s JSON messages without native metadata',
    async source => {
      const file = source === 'main' ? deps.getMainLogFiles()[0] : deps.getGatewayLogFile();
      await fs.writeFile(file, line(now - 1500, JSON.stringify({
        message: '[OpenClaw] SQLITE_BUSY database is locked',
      })));

      const report = await collect();

      expect(report.evidence).toContainEqual(expect.objectContaining({
        source, timestamp: now - 1500, category: 'storage',
      }));
      expect(report.coverage.find(item => item.source === source)?.issues).not.toContain('invalid_record');
    },
  );

  it('keeps local evidence and reports missing sources when the native RPC fails', async () => {
    await fs.writeFile(
      deps.getGatewayLogFile(),
      line(now - 1500, '[gateway] Cannot find module xyz'),
    );
    deps.getGatewayClient = () =>
      ({
        request: vi.fn().mockRejectedValue(new Error('offline')),
      }) as unknown as GatewayClientLike;
    const report = await collect();
    expect(report.evidence.some(e => e.category === 'runtime')).toBe(true);
    expect(report.coverage.find(c => c.source === 'main')?.issues).toContain('missing');
    expect(report.coverage.find(c => c.source === 'native')?.issues).toContain('unavailable');
  });

  it('retains ordinary engine startup context without promoting it to failure evidence', async () => {
    await fs.writeFile(
      deps.getGatewayLogFile(),
      line(now - 2000, '[gateway] engine startup ready', 'stdout') +
        line(now - 1800, '[gateway] EXTENSION ready', 'stdout'),
    );
    const report = await collect();
    expect(report.evidence.filter(e => e.source === 'gateway').every(e => e.level === 'info')).toBe(
      true,
    );
    expect(
      report.findings.every(id => report.evidence.find(e => e.id === id)?.source === 'engine'),
    ).toBe(true);
  });

  it('reassembles separately timestamped Gateway stack and cause lines', async () => {
    await fs.writeFile(
      deps.getGatewayLogFile(),
      line(now - 1900, '[gateway] startup failed', 'stderr') +
        line(now - 1899, '    at start (runtime.js:40)', 'stderr') +
        line(now - 1898, 'cause: Error: listen EADDRINUSE', 'stderr'),
    );
    const report = await collect();
    const finding = report.evidence.find(item => item.id === report.findings[0]);
    expect(finding?.category).toBe('port');
    expect(finding?.text).toContain('runtime.js:40');
    expect(finding?.text).toContain('cause: Error: listen EADDRINUSE');
    expect(report.evidence.filter(item => item.source === 'gateway')).toHaveLength(1);
  });

  it('reports omitted and oversized records while still scanning for a later concrete error', async () => {
    await fs.writeFile(
      deps.getGatewayLogFile(),
      Array.from({ length: 70 }, (_, n) =>
        line(now - 2000 + n, `[gateway] startup warning ${n}`, 'warn'),
      ).join('') +
        line(now - 1500, `[gateway] ${'x'.repeat(70_000)}`) +
        line(now - 1400, '[gateway] ENOSPC disk full'),
    );
    const report = await collect();
    const coverage = report.coverage.find(c => c.source === 'gateway')!;
    expect(coverage.scannedFiles).toBe(1);
    expect(coverage.matched).toBe(71);
    expect(coverage.omitted).toBe(41);
    expect(coverage.issues).toContain('oversized');
    expect(report.evidence.find(e => e.id === report.findings[0])?.category).toBe('storage');
  });

  it('flags an engine replacement that occurs during collection', async () => {
    let reads = 0;
    deps.getContext = () => (++reads === 1 ? context : { ...context, processGeneration: 3 });
    expect((await collect()).engineChanged).toBe(true);
  });

  it('does not publish a partially collected result after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(controller.signal)).rejects.toThrow('canceled');
  });

  it.each(['cancel', 'failure', 'path_failure'] as const)(
    'keeps the collection pending until every source settles after %s',
    async outcome => {
      const main = Promise.withResolvers<void>();
      const gateway = Promise.withResolvers<void>();
      const gatewayFile = deps.getGatewayLogFile();
      vi.spyOn(logScanner, 'scanDiagnosticLog').mockImplementation(file =>
        file === gatewayFile ? gateway.promise : main.promise,
      );
      if (outcome === 'failure') {
        deps.getGatewayClient = () => { throw new Error('client unavailable'); };
      }
      if (outcome === 'path_failure') {
        deps.getGatewayLogFile = () => { throw new Error('path unavailable'); };
      }
      const controller = new AbortController();
      const result = collect(controller.signal);
      let settled = false;
      const observed = result.then(
        value => { settled = true; return value; },
        error => { settled = true; throw error; },
      );
      const rejection = expect(observed).rejects.toThrow(
        outcome === 'cancel' ? 'canceled' :
          outcome === 'path_failure' ? 'path unavailable' : 'client unavailable',
      );
      if (outcome === 'cancel') {
        controller.abort();
        main.reject(new Error('canceled'));
      } else if (outcome === 'failure') main.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);

      gateway.resolve();
      main.resolve();
      await rejection;
      expect(settled).toBe(true);
    },
  );

  it('rejects a symlink log source and records the gap', async () => {
    const real = path.join(directory, 'real');
    const link = path.join(directory, 'linked');
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, 'gateway.log'), line(now - 1500, '[gateway] EADDRINUSE'));
    await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    deps.getGatewayLogFile = () => path.join(link, 'gateway.log');
    const report = await collect();
    expect(report.coverage.find(c => c.source === 'gateway')?.issues).toContain('unsafe');
    expect(report.evidence.some(e => e.category === 'port')).toBe(false);
  });

  it.each([
    ['Error: invalid configuration at plugins', 'config'],
    ['NODE_MODULE_VERSION 146 does not match 137', 'runtime'],
    ['Secret provider credential missing', 'credentials'],
    ['CERT_HAS_EXPIRED', 'certificate'],
    ['getaddrinfo ENOTFOUND internal.model', 'network'],
    ['JavaScript heap out of memory', 'memory'],
  ])('categorizes an explicit failure: %s', (text, category) => {
    expect(classifyEngineFailure(text)).toBe(category);
  });
});
