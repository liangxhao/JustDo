import { randomUUID } from 'node:crypto';

import type {
  DiagnosticEvent,
  DiagnosticQuery,
  DiagnosticReport,
  DiagnosticScanProgress,
} from '../../../shared/cowork/sessionDiagnostics';
import type { SessionDiagnosticsStore } from '../../data/sessionDiagnosticsStore';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import {
  projectDiagnosticEvent,
  type ProjectedDiagnostic,
} from '../../engine/openclaw/runtimeDiagnostics';
import { classifyDiagnostics } from './classifier';
import { projectDiagnosticEnvironment } from './environment';
import { DiagnosticExportLogs } from './exportLogs';
import { collectDiagnosticHistory } from './historyCollector';
import { collectDiagnosticLogs } from './logCollector';
import { discoverNativeDiagnosticLogs } from './logScanner';

export interface DiagnosticRuntime {
  getGatewayClient(): GatewayClientLike | null;
  resolveDiagnosticSession(runId: string, sessionKey?: string): string | null;
}
interface Dependencies {
  store: SessionDiagnosticsStore;
  hasSession: (id: string) => boolean;
  getNativeSessionKey: (id: string) => string | null;
  getRuntime: () => DiagnosticRuntime | null;
  now?: () => number;
  logSources?: Record<'main' | 'cowork' | 'gateway', (report: DiagnosticReport) => string[]>;
}
export class DiagnosticServiceError extends Error {
  constructor(readonly reason: 'invalid' | 'missing' | 'expired' | 'busy') {
    super(reason);
  }
}
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
export function validateDiagnosticQuery(input: unknown): asserts input is DiagnosticQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DiagnosticServiceError('invalid');
  const value = input as DiagnosticQuery;
  if (
    !validId(value.sessionId) ||
    (value.sessionRunId !== undefined && !validId(value.sessionRunId))
  ) {
    throw new DiagnosticServiceError('invalid');
  }
}

/** No start/send/stop/config methods are available to the read service. */
export class SessionDiagnosticsService {
  private epoch = randomUUID();
  private pending: Array<ProjectedDiagnostic & { sessionId?: string }> = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private storageFailed = false;
  private lost = 0;
  private readonly snapshots = new Map<
    string,
    { owner: number; report: DiagnosticReport; savedAt: number }
  >();
  private readonly refreshing = new Set<number>();
  private readonly collecting = new Set<number>();
  private readonly pinnedSnapshots = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    try {
      deps.store.prune(this.now());
    } catch {
      this.storageFailed = true;
    }
  }

  observe(frame: GatewayEventFrame): void {
    try {
      const projected = projectDiagnosticEvent(frame, this.epoch, this.now());
      if (!projected) return;
      if (this.pending.length >= 100) {
        this.pending.shift();
        this.lost++;
      }
      const sessionId =
        this.deps
          .getRuntime()
          ?.resolveDiagnosticSession(projected.nativeRunId, projected.sessionKey) ?? undefined;
      this.pending.push({ ...projected, sessionId });
      // Capture known terminal evidence before active-turn cleanup can discard identity.
      if (projected.event.executionSettled || projected.event.kind === 'chat') this.flush();
      // Run binding is performed by the execution owner after gatewayEvent delivery.
      this.scheduleFlush();
    } catch {
      this.storageFailed = true;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
      if (this.pending.length) this.scheduleFlush();
    }, 250);
    this.flushTimer.unref();
  }

  flush(): void {
    const runtime = this.deps.getRuntime();
    const retained: typeof this.pending = [];
    for (const projected of this.pending) {
      if (this.now() - projected.event.observedAt > 30_000) {
        this.lost++;
        continue;
      }
      try {
        const sessionId =
          projected.sessionId ??
          runtime?.resolveDiagnosticSession(projected.nativeRunId, projected.sessionKey);
        if (sessionId && !this.deps.hasSession(sessionId)) continue;
        const runId = sessionId && this.deps.store.resolveRun(sessionId, projected.nativeRunId);
        if (!sessionId || !runId) {
          retained.push(projected);
          continue;
        }
        this.deps.store.append(sessionId, { ...projected.event, runId });
      } catch {
        this.storageFailed = true;
        this.lost++;
      }
    }
    this.pending = retained;
  }

  recordCancellation(input: {
    sessionId: string;
    nativeRunId?: string;
    phase: 'requested' | 'acknowledged' | 'failed';
    userInitiated: boolean;
  }): void {
    try {
      this.flush();
      if (!input.nativeRunId) return;
      const runId = this.deps.store.resolveRun(input.sessionId, input.nativeRunId);
      if (!runId) return;
      const generations = this.deps.store
        .read(input.sessionId, runId)
        .events.filter(event => event.nativeRunId === input.nativeRunId && event.generation)
        .map(event => event.generation!);
      const generation = generations.at(-1);
      this.deps.store.append(input.sessionId, {
        id: randomUUID(),
        runId,
        nativeRunId: input.nativeRunId,
        ...(generation ? { generation } : {}),
        epoch: this.epoch,
        observedAt: this.now(),
        kind: 'cancel',
        phase: input.phase,
        userInitiated: input.userInitiated,
      });
    } catch {
      this.storageFailed = true;
    }
  }

  recordConnection(input: {
    connected: boolean;
    runs: Array<{ sessionId: string; nativeRunId: string }>;
  }): void {
    this.flush();
    for (const run of input.runs) {
      try {
        const runId = this.deps.store.resolveRun(run.sessionId, run.nativeRunId);
        if (!runId) continue;
        this.deps.store.append(run.sessionId, {
          id: randomUUID(),
          runId,
          nativeRunId: run.nativeRunId,
          epoch: this.epoch,
          observedAt: this.now(),
          kind: 'connection',
          phase: input.connected ? 'connected' : 'disconnected',
        });
      } catch {
        this.storageFailed = true;
      }
    }
    if (input.connected) this.epoch = randomUUID();
  }

  private assertSession(query: unknown): asserts query is DiagnosticQuery {
    validateDiagnosticQuery(query);
    if (!this.deps.hasSession(query.sessionId)) throw new DiagnosticServiceError('missing');
  }

  list(query: { sessionId: string; cursor?: string }) {
    this.assertSession(query);
    if (query.cursor !== undefined && !validId(query.cursor))
      throw new DiagnosticServiceError('invalid');
    if (query.cursor && !this.deps.store.getRun(query.sessionId, query.cursor))
      throw new DiagnosticServiceError('invalid');
    return this.deps.store.listRuns(query.sessionId, query.cursor);
  }

  read(query: DiagnosticQuery, owner: number): DiagnosticReport {
    this.assertSession(query);
    this.flush();
    const run = this.deps.store.getRun(query.sessionId, query.sessionRunId);
    if (query.sessionRunId && !run) throw new DiagnosticServiceError('missing');
    const data = run
      ? this.deps.store.read(query.sessionId, run.id)
      : {
          events: [] as DiagnosticEvent[],
          coverage: { dropped: 0, storageFailed: false, partial: true as const },
        };
    const report: DiagnosticReport = {
      version: 1,
      snapshotId: randomUUID(),
      sessionId: query.sessionId,
      collectedAt: this.now(),
      ...(run ? { run } : {}),
      events: data.events,
      conclusion: classifyDiagnostics(data.events),
      coverage: {
        ...data.coverage,
        collectorDropped: this.lost,
        storageFailed: this.storageFailed || data.coverage.storageFailed,
      },
      connection: this.deps.getRuntime()?.getGatewayClient() ? 'connected' : 'offline',
      environment: { status: 'not_requested' },
    };
    this.remember(report, owner);
    return report;
  }

  private remember(report: DiagnosticReport, owner: number): void {
    for (const [id, item] of this.snapshots) {
      if (
        (!this.pinnedSnapshots.has(id) && this.now() - item.savedAt > 300_000) ||
        !this.deps.hasSession(item.report.sessionId)
      )
        this.snapshots.delete(id);
    }
    if (Buffer.byteLength(JSON.stringify(report)) > 512 * 1024)
      throw new DiagnosticServiceError('invalid');
    this.snapshots.set(report.snapshotId, { report, owner, savedAt: this.now() });
    while (this.snapshots.size > 8) {
      const candidate = [...this.snapshots.keys()].find(id => !this.pinnedSnapshots.has(id));
      if (!candidate) break;
      this.snapshots.delete(candidate);
    }
  }

  snapshot(query: DiagnosticQuery & { snapshotId: string }, owner: number): DiagnosticReport {
    this.assertSession(query);
    if (!validId(query.snapshotId)) throw new DiagnosticServiceError('invalid');
    const saved = this.snapshots.get(query.snapshotId);
    if (
      !saved ||
      saved.owner !== owner ||
      saved.report.sessionId !== query.sessionId ||
      (query.sessionRunId !== undefined && saved.report.run?.id !== query.sessionRunId) ||
      (!this.pinnedSnapshots.has(query.snapshotId) && this.now() - saved.savedAt > 300_000)
    )
      throw new DiagnosticServiceError('expired');
    if (saved.report.run && !this.deps.store.getRun(query.sessionId, saved.report.run.id))
      throw new DiagnosticServiceError('missing');
    return saved.report;
  }

  async refresh(
    query: DiagnosticQuery & { snapshotId: string },
    owner: number,
  ): Promise<DiagnosticReport> {
    const previous = this.snapshot(query, owner);
    if (this.refreshing.has(owner)) throw new DiagnosticServiceError('busy');
    this.refreshing.add(owner);
    const runtime = this.deps.getRuntime();
    const client = runtime?.getGatewayClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let environment: DiagnosticReport['environment'] = {
      status: 'unavailable',
      collectedAt: this.now(),
    };
    try {
      if (client) {
        const response = await Promise.race([
          client.request<unknown>('diagnostics.stability', {
            limit: 1000,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 3000);
          }),
        ]);
        if (runtime === this.deps.getRuntime() && client === runtime.getGatewayClient()) {
          environment = projectDiagnosticEnvironment(response, this.now());
        }
      }
    } catch {
      /* Optional online evidence must never block the local report. */
    } finally {
      clearTimeout(timer);
      this.refreshing.delete(owner);
    }
    this.snapshot(query, owner); // Revalidate after the asynchronous request/deletion/expiry.
    const report = { ...previous, snapshotId: randomUUID(), environment };
    this.remember(report, owner);
    return report;
  }

  /** Raw text exists only during the user-requested local export, never in snapshots or IPC. */
  async exportLogs(
    query: DiagnosticQuery & { snapshotId: string },
    owner: number,
    signal?: AbortSignal,
  ) {
    const capture = new DiagnosticExportLogs();
    const report = await this.collect(query, owner, {
      signal,
      onExportRecord: (source, text, association) => capture.append(source, text, association),
    });
    return { report, logs: capture.finish() };
  }

  async collect(
    query: DiagnosticQuery & { snapshotId: string },
    owner: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: DiagnosticScanProgress) => void;
      onExportRecord?: NonNullable<Parameters<typeof collectDiagnosticLogs>[3]>['onExportRecord'];
    } = {},
  ): Promise<DiagnosticReport> {
    const previous = this.snapshot(query, owner);
    if (this.collecting.has(owner) || this.collecting.size >= 2)
      throw new DiagnosticServiceError('busy');
    this.collecting.add(owner);
    this.pinnedSnapshots.add(query.snapshotId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sessionKey = this.deps.getNativeSessionKey(previous.sessionId);
      const runtime = this.deps.getRuntime();
      const client = runtime?.getGatewayClient();
      let native:
        | {
            lines: string[];
            truncated?: boolean;
            files?: string[];
            discoveryFailure?: 'unsafe_file' | 'unreadable' | 'read_timeout' | 'canceled';
          }
        | undefined;
      if (client) {
        try {
          const response = await Promise.race([
            client.request<{ lines?: unknown; truncated?: unknown; file?: unknown }>('logs.tail', {
              limit: 1000,
              maxBytes: 524288,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), 3000);
            }),
          ]);
          if (
            runtime === this.deps.getRuntime() &&
            client === runtime.getGatewayClient() &&
            Array.isArray(response?.lines)
          ) {
            let bytes = 0;
            const lines: string[] = [];
            let truncated = response.truncated !== false;
            // Native tails are chronological; prioritize the latest failure when reapplying limits.
            for (
              let index = response.lines.length - 1;
              index >= Math.max(0, response.lines.length - 1000);
              index--
            ) {
              const line = response.lines[index];
              if (typeof line !== 'string') {
                truncated = true;
                continue;
              }
              const lineBytes = Buffer.byteLength(line) + 1;
              if (lineBytes > 65537 || bytes + lineBytes > 524288) {
                truncated = true;
                continue;
              }
              bytes += lineBytes;
              lines.push(line);
            }
            truncated ||= response.lines.length > 1000;
            native = { lines: lines.reverse(), truncated };
            try {
              const files = await discoverNativeDiagnosticLogs(response.file, options.signal);
              if (files.length) native.files = files;
            } catch (error) {
              // Keep the partial native tail and record why full source discovery failed.
              native.truncated = true;
              const message = error instanceof Error ? error.message : '';
              native.discoveryFailure =
                message === 'unsafe_file' || message === 'read_timeout' || message === 'canceled'
                  ? message
                  : 'unreadable';
            }
          }
        } catch {
          /* Native collection is optional and never starts an offline runtime. */
        } finally {
          clearTimeout(timer);
        }
      }
      this.snapshot(query, owner);
      const sources = { main: [] as string[], cowork: [] as string[], gateway: [] as string[] };
      const failedSources = new Set<string>();
      for (const source of ['main', 'cowork', 'gateway'] as const) {
        try {
          sources[source] = this.deps.logSources?.[source](previous) ?? [];
        } catch {
          failedSources.add(source);
        }
      }
      const logs = await collectDiagnosticLogs(previous, sources, native, {
        fullScan: true,
        onExportRecord: options.onExportRecord,
        signal: options.signal,
        onProgress: progress => options.onProgress?.({ ...progress, snapshotId: query.snapshotId }),
      });
      for (const coverage of logs.sources) {
        if (failedSources.has(coverage.source)) {
          coverage.status = 'unavailable';
          coverage.reasons = ['unreadable'];
        }
      }
      this.snapshot(query, owner);
      const history = await collectDiagnosticHistory(
        previous,
        client,
        sessionKey === this.deps.getNativeSessionKey(previous.sessionId) ? sessionKey : null,
        options.signal,
      );
      this.snapshot(query, owner);
      if (
        runtime !== this.deps.getRuntime() ||
        client !== runtime?.getGatewayClient() ||
        sessionKey !== this.deps.getNativeSessionKey(previous.sessionId)
      ) {
        history.status = 'changed';
        history.reason = 'history_changed';
        history.failures = [];
        delete history.lastResponse;
      }
      const report = { ...previous, snapshotId: randomUUID(), logs, history };
      this.remember(report, owner);
      return report;
    } finally {
      clearTimeout(timer);
      this.collecting.delete(owner);
      this.pinnedSnapshots.delete(query.snapshotId);
    }
  }
}
