import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initializeSessionDiagnosticsTables,
  SessionDiagnosticsStore,
} from '../../data/sessionDiagnosticsStore';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { type DiagnosticRuntime, SessionDiagnosticsService } from './service';

describe('SessionDiagnosticsService', () => {
  let db: Database.Database;
  let service: SessionDiagnosticsService;
  let store: SessionDiagnosticsStore;
  let currentTime: number;
  let connected: boolean;
  let resolved: boolean;
  let client: GatewayClientLike;
  let request: ReturnType<typeof vi.fn>;
  let logSources: Record<'main' | 'cowork' | 'gateway', ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    vi.useFakeTimers();
    currentTime = Date.now();
    connected = false;
    resolved = true;
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_session_runs (id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES cowork_sessions(id) ON DELETE CASCADE,
        root_run_id TEXT, client_turn_id TEXT, started_at INTEGER, ended_at INTEGER, state TEXT);
      INSERT INTO cowork_sessions VALUES ('s'), ('other');
      INSERT INTO cowork_session_runs VALUES ('r', 's', 'native', 'client', 100, NULL, 'running');
      INSERT INTO cowork_session_runs VALUES ('other-run', 'other', 'other-native', 'other-client', 100, NULL, 'running');`);
    initializeSessionDiagnosticsTables(db);
    store = new SessionDiagnosticsStore(db);
    request = vi.fn().mockResolvedValue({ count: 1, dropped: 0 });
    logSources = { main: vi.fn(() => []), cowork: vi.fn(() => []), gateway: vi.fn(() => []) };
    client = { start: vi.fn(), stop: vi.fn(), request: request as GatewayClientLike['request'] };
    const runtime: DiagnosticRuntime = {
      getGatewayClient: () => (connected ? client : null),
      resolveDiagnosticSession: (runId, key) =>
        resolved && runId === 'native' && key === 'session-key' ? 's' : null,
    };
    service = new SessionDiagnosticsService({
      store,
      now: () => currentTime,
      getRuntime: () => runtime,
      logSources,
      hasSession: id => !!db.prepare('SELECT id FROM cowork_sessions WHERE id = ?').get(id),
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    db.close();
  });

  it('retains pre-binding metadata until exact run and session binding is available', () => {
    resolved = false;
    service.observe({
      event: 'agent',
      payload: {
        runId: 'native',
        sessionKey: 'session-key',
        stream: 'lifecycle',
        data: { phase: 'end', stopReason: 'end_turn', executionSettled: true },
      },
    });
    service.flush();
    expect(store.read('s', 'r').events).toHaveLength(0);
    resolved = true;
    service.flush();
    expect(service.read({ sessionId: 's' }, 1).conclusion.reason).toBe('completed');
    expect(store.read('other', 'other-run').events).toHaveLength(0);
  });

  it('reads and refreshes offline without starting a client or invoking RPC', async () => {
    const report = service.read({ sessionId: 's' }, 1);
    const refreshed = await service.refresh({ sessionId: 's', snapshotId: report.snapshotId }, 1);
    expect(refreshed.connection).toBe('offline');
    expect(refreshed.environment.status).toBe('unavailable');
    expect(client.start).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('collects offline partial evidence into a new snapshot without changing the displayed outcome', async () => {
    const original = service.read({ sessionId: 's' }, 1);
    const query = { sessionId: 's', snapshotId: original.snapshotId };
    const result = await service.collect(query, 1);
    expect(result.snapshotId).not.toBe(original.snapshotId);
    expect(result.logs?.sources.map(source => source.source)).toEqual(
      expect.arrayContaining(['main', 'cowork', 'gateway', 'native']),
    );
    expect(result.logs?.sources.find(source => source.source === 'native')?.status).toBe(
      'unavailable',
    );
    expect(result.conclusion).toEqual(original.conclusion);
    expect(service.snapshot(query, 1).logs).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it('uses bounded native reads and never retains native paths or arbitrary text', async () => {
    connected = true;
    request.mockResolvedValue({
      file: 'SECRET-path',
      truncated: false,
      lines: [
        JSON.stringify({
          time: new Date(currentTime).toISOString(),
          statusCode: 429,
          message: 'SECRET-prompt Bearer SECRET-token',
        }),
      ],
    });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(request).toHaveBeenCalledWith('logs.tail', { limit: 1000, maxBytes: 524288 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.logs?.sources.find(source => source.source === 'native')?.status).not.toBe(
      'unavailable',
    );
    expect(client.start).not.toHaveBeenCalled();
  });

  it('times out native collection and releases its busy guard', async () => {
    connected = true;
    request.mockReturnValue(new Promise(() => {}));
    const original = service.read({ sessionId: 's' }, 1);
    const query = { sessionId: 's', snapshotId: original.snapshotId };
    const pending = service.collect(query, 1);
    await expect(service.collect(query, 1)).rejects.toMatchObject({ reason: 'busy' });
    await vi.advanceTimersByTimeAsync(3001);
    const result = await pending;
    expect(result.logs?.sources.find(source => source.source === 'native')?.status).toBe(
      'unavailable',
    );
    connected = false;
    await expect(service.collect(query, 1)).resolves.toHaveProperty('logs');
  });

  it('isolates source discovery failures and marks them unreadable instead of missing', async () => {
    logSources.main.mockImplementation(() => {
      throw new Error('SECRET-denied-path');
    });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(logSources.cowork).toHaveBeenCalled();
    expect(logSources.gateway).toHaveBeenCalled();
    expect(result.logs?.sources.find(source => source.source === 'main')?.reasons).toEqual([
      'unreadable',
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('caps examined native array entries even when all entries are malformed', async () => {
    connected = true;
    const lines = Array.from({ length: 1001 }, () => null);
    const beyondLimit = vi.fn(() => {
      throw new Error('should not inspect');
    });
    Object.defineProperty(lines, 0, { get: beyondLimit });
    request.mockResolvedValue({ lines, truncated: false });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(beyondLimit).not.toHaveBeenCalled();
    expect(result.logs?.sources.find(source => source.source === 'native')?.truncated).toBe(true);
  });

  it('caps concurrent collections across windows and releases capacity after completion', async () => {
    connected = true;
    const finish: Array<(value: unknown) => void> = [];
    request.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    const queries = [1, 2, 3].map(owner => ({
      sessionId: 's',
      snapshotId: service.read({ sessionId: 's' }, owner).snapshotId,
    }));
    const first = service.collect(queries[0], 1);
    const second = service.collect(queries[1], 2);
    await expect(service.collect(queries[2], 3)).rejects.toMatchObject({ reason: 'busy' });
    finish.forEach(resolve => resolve({ lines: [] }));
    await Promise.all([first, second]);
    connected = false;
    await expect(service.collect(queries[2], 3)).resolves.toHaveProperty('logs');
  });

  it('retains the final native failure after an oversized tool-output log record', async () => {
    connected = true;
    request.mockResolvedValue({
      truncated: false,
      lines: [
        'SECRET-content'.repeat(6000),
        JSON.stringify({ time: new Date(currentTime).toISOString(), errorCategory: 'timeout' }),
      ],
    });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(result.logs?.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'native', signal: 'timeout' })]),
    );
    expect(result.logs?.sources.find(source => source.source === 'native')?.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('includes native separators in the byte budget without losing the latest failure', async () => {
    connected = true;
    const prefix = JSON.stringify({
      time: new Date(currentTime).toISOString(),
      errorCategory: 'timeout',
    });
    const padded = prefix + ' '.repeat(65536 - Buffer.byteLength(prefix));
    request.mockResolvedValue({ truncated: false, lines: Array.from({ length: 8 }, () => padded) });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    const native = result.logs?.sources.find(source => source.source === 'native');
    expect(native?.bytesRead).toBe(7 * 65537);
    expect(native?.truncated).toBe(true);
    expect(result.logs?.records).toHaveLength(7);
  });

  it('discards native results after a connection change', async () => {
    connected = true;
    request.mockImplementation(async () => {
      connected = false;
      return { lines: [] };
    });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(result.logs?.sources.find(source => source.source === 'native')?.status).toBe(
      'unavailable',
    );
  });

  it('marks rejected native file discovery as incomplete while retaining safe tail evidence', async () => {
    connected = true;
    request.mockResolvedValue({ file: 'relative.log', lines: [], truncated: false });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(result.logs?.sources[3]).toMatchObject({ scanComplete: false, status: 'partial' });
    expect(result.logs?.sources[3].reasons).toContain('unsafe_file');
  });

  it('pins a snapshot during a long scan and gives the result a fresh export lifetime', async () => {
    connected = true;
    request.mockImplementation(async () => {
      currentTime += 300001;
      return { lines: [] };
    });
    const original = service.read({ sessionId: 's' }, 1);
    const result = await service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    expect(result.logs).toBeDefined();
    expect(service.snapshot({ sessionId: 's', snapshotId: result.snapshotId }, 1)).toBe(result);
    currentTime += 300001;
    expect(() => service.snapshot({ sessionId: 's', snapshotId: result.snapshotId }, 1)).toThrow(
      'expired',
    );
  });

  it('rejects deleted sessions after native collection and before retaining evidence', async () => {
    connected = true;
    let finish!: (value: unknown) => void;
    request.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const original = service.read({ sessionId: 's' }, 1);
    const pending = service.collect({ sessionId: 's', snapshotId: original.snapshotId }, 1);
    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('s');
    finish({ lines: [] });
    await expect(pending).rejects.toMatchObject({ reason: 'missing' });
  });

  it('treats rejected optional online diagnostics as partial evidence', async () => {
    connected = true;
    request.mockRejectedValue(new Error('unsupported method'));
    const report = service.read({ sessionId: 's' }, 1);
    const refreshed = await service.refresh({ sessionId: 's', snapshotId: report.snapshotId }, 1);
    expect(refreshed.environment.status).toBe('unavailable');
    expect(refreshed.run?.id).toBe('r');
    expect(client.start).not.toHaveBeenCalled();
  });

  it('bounds online waits and retains the offline snapshot on timeout', async () => {
    connected = true;
    request.mockReturnValue(new Promise(() => {}));
    const report = service.read({ sessionId: 's' }, 1);
    const pending = service.refresh({ sessionId: 's', snapshotId: report.snapshotId }, 1);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).environment.status).toBe('unavailable');
  });

  it('rejects cross-window, expired and cross-session snapshot access', () => {
    const report = service.read({ sessionId: 's' }, 1);
    expect(() => service.snapshot({ sessionId: 's', snapshotId: report.snapshotId }, 2)).toThrow(
      'expired',
    );
    expect(() =>
      service.snapshot({ sessionId: 'other', snapshotId: report.snapshotId }, 1),
    ).toThrow('expired');
    currentTime += 300001;
    expect(() => service.snapshot({ sessionId: 's', snapshotId: report.snapshotId }, 1)).toThrow(
      'expired',
    );
  });

  it('rejects deleted snapshots including deletion during the online request', async () => {
    connected = true;
    let complete!: (value: unknown) => void;
    request.mockReturnValue(
      new Promise(resolve => {
        complete = resolve;
      }),
    );
    const report = service.read({ sessionId: 's' }, 1);
    const pending = service.refresh({ sessionId: 's', snapshotId: report.snapshotId }, 1);
    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('s');
    complete({ count: 0, dropped: 0 });
    await expect(pending).rejects.toThrow('missing');
    expect(() => service.snapshot({ sessionId: 's', snapshotId: report.snapshotId }, 1)).toThrow(
      'missing',
    );
  });

  it('reports unbound metadata loss after expiry instead of attaching it to the latest run', () => {
    service.observe({
      event: 'chat',
      payload: { runId: 'unbound', sessionKey: 'session-key', state: 'final' },
    });
    currentTime += 30001;
    service.flush();
    const report = service.read({ sessionId: 's' }, 1);
    expect(report.events).toHaveLength(0);
    expect(report.coverage.dropped).toBe(0);
    expect(report.coverage.collectorDropped).toBe(1);
    expect(report.conclusion.reason).toBe('unknown');
  });
});
