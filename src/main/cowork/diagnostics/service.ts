import { randomUUID } from 'node:crypto';

import { DiagnosticRuntimeFailure } from '../../../shared/cowork/diagnostics/diagnosticRuntimeFailure';
import type {
  DiagnosticEvent,
  DiagnosticGatewayInfo,
  DiagnosticHistoryUpdate,
  DiagnosticQuery,
  DiagnosticReport,
  DiagnosticRuntimeArtifact,
  DiagnosticRuntimeInfo,
  DiagnosticScanProgress,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import type { SessionDiagnosticsStore } from '../../data/sessionDiagnosticsStore';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import {
  projectDiagnosticEvent,
  type ProjectedDiagnostic,
} from '../../engine/openclaw/runtimeDiagnostics';
import { OPENCLAW_WIRE_VERSION } from '../../engine/openclaw/wire/v2026_10_6';
import { classifyDiagnostics } from './classifier';
import { projectDiagnosticEnvironment } from './environment';
import { collectDiagnosticExportContext } from './exportContext';
import { DiagnosticExportLogs } from './exportLogs';
import { collectDiagnosticPluginInventory } from './exportPluginInventory';
import { DiagnosticExportRequests } from './exportRequests';
import {
  collectDiagnosticSessionUsage,
  describeDiagnosticSession,
  type DiagnosticLocalSessionDetails,
  type DiagnosticSessionBinding,
} from './exportSessionDetails';
import { collectDiagnosticHistory } from './historyCollector';
import { collectDiagnosticLogs, type NativeDiagnosticLogs } from './logCollector';
import { discoverNativeDiagnosticLogs } from './logScanner';

export interface DiagnosticRuntime {
  getGatewayClient(): GatewayClientLike | null;
  getGatewayClientGeneration?(): number;
  getDiagnosticGatewayInfo?(): DiagnosticGatewayInfo | null;
  resolveDiagnosticSession(runId: string, sessionKey?: string): string | null;
}
interface Dependencies {
  store: SessionDiagnosticsStore;
  hasSession: (id: string) => boolean;
  getSessionBinding: (id: string) => DiagnosticSessionBinding | null;
  getExportSessionDetails?: (id: string, runId?: string) => DiagnosticLocalSessionDetails | undefined;
  getPluginInventorySources?: () => Pick<
    Parameters<typeof collectDiagnosticPluginInventory>[0],
    'readExtensions' | 'readMcpServers' | 'readSavedHooks' | 'readAppPlugins'
  >;
  getRuntime: () => DiagnosticRuntime | null;
  getRuntimeArtifact?: (signal?: AbortSignal) => Promise<DiagnosticRuntimeArtifact | undefined>;
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
      if (projected.event.runtimeFailure === DiagnosticRuntimeFailure.ReplayAdmissionRejected) {
        // Logging is optional evidence; failure must not discard the original event.
        try {
          const event = projected.event;
          console.warn(
            JSON.stringify({
              message: '[SessionDiagnosticsService] Native replay admission rejection observed',
              runtimeFailure: event.runtimeFailure,
              site: 'not_exposed',
              source: frame.event,
              nativeRunId: projected.nativeRunId,
              ...(validId(sessionId) ? { sessionId } : {}),
              ...(projected.sessionKey ? { sessionKey: projected.sessionKey } : {}),
              ...(event.generation ? { generation: event.generation } : {}),
              ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
              phase: event.phase,
              ...(event.executionSettled === undefined
                ? {}
                : { executionSettled: event.executionSettled }),
              ...(event.providerStarted === undefined
                ? {}
                : { providerStarted: event.providerStarted }),
            }),
          );
        } catch {
          // Main logging must not change storage coverage or native execution.
        }
      }
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
    stagingDirectory: string,
    signal?: AbortSignal,
    options: { onProgress?: (progress: DiagnosticScanProgress) => void } = {},
  ) {
    const selected = this.snapshot(query, owner);
    // A save dialog can stay open while this run gains new terminal evidence.
    // Refresh the selected run explicitly; never follow a later session run.
    const current =
      selected.run && (selected.run.state === 'running' || selected.run.endedAt !== undefined)
        ? this.read({ sessionId: selected.sessionId, sessionRunId: selected.run.id }, owner)
        : selected;
    const collectionQuery = {
      ...query,
      snapshotId: current.snapshotId,
      ...(selected.run ? { sessionRunId: selected.run.id } : {}),
    };
    const capture = new DiagnosticExportLogs();
    const collected = await this.collectEvidence(collectionQuery, owner, {
      signal,
      onProgress: progress => options.onProgress?.({ ...progress, snapshotId: query.snapshotId }),
      exportLogs: capture,
      stagingDirectory,
    });
    return { ...collected, logs: capture.finish() };
  }

  async collect(
    query: DiagnosticQuery & { snapshotId: string },
    owner: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: DiagnosticScanProgress) => void;
      onHistory?: (update: DiagnosticHistoryUpdate) => void;
    } = {},
  ): Promise<DiagnosticReport> {
    return (await this.collectEvidence(query, owner, options)).report;
  }

  private async collectEvidence(
    query: DiagnosticQuery & { snapshotId: string },
    owner: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: DiagnosticScanProgress) => void;
      onHistory?: (update: DiagnosticHistoryUpdate) => void;
      exportLogs?: DiagnosticExportLogs;
      stagingDirectory?: string;
    },
  ) {
    const previous = this.snapshot(query, owner);
    if (this.collecting.has(owner) || this.collecting.size >= 2)
      throw new DiagnosticServiceError('busy');
    this.collecting.add(owner);
    this.pinnedSnapshots.add(query.snapshotId);
    try {
      const { exportLogs } = options;
      const binding = this.deps.getSessionBinding(previous.sessionId);
      const sessionKey = binding?.key ?? null;
      const nativeRunIds = previous.run
        ? this.deps.store.getNativeRunIds(previous.sessionId, previous.run.id)
        : [];
      const runtime = this.deps.getRuntime();
      const client = runtime?.getGatewayClient();
      const generation = runtime?.getGatewayClientGeneration?.();
      const exportRuns = exportLogs ? this.deps.store.listExportRuns(previous.sessionId) : undefined;
      const sessionIdentityTask = exportLogs
        ? describeDiagnosticSession(binding, client, options.signal).then(identity => {
            if (identity.replaced) throw new DiagnosticServiceError('expired');
            return identity.nativeSessionId;
          })
        : Promise.resolve(undefined);
      const runtimeInfo: DiagnosticRuntimeInfo = {
        scope: 'collection_environment',
        collectedAt: this.now(),
        wireVersion: OPENCLAW_WIRE_VERSION,
        gateway: {
          status: client ? 'connected' : 'offline',
          ...(client ? runtime?.getDiagnosticGatewayInfo?.() : {}),
        },
      };
      const connectionCurrent = () =>
        runtime === this.deps.getRuntime() &&
        client === runtime?.getGatewayClient() &&
        generation === runtime?.getGatewayClientGeneration?.();
      const bindingCurrent = () => {
        const current = this.deps.getSessionBinding(previous.sessionId);
        return (
          binding?.key === current?.key &&
          binding?.nativeSessionId === current?.nativeSessionId &&
          JSON.stringify(nativeRunIds) ===
            JSON.stringify(
              previous.run
                ? this.deps.store.getNativeRunIds(previous.sessionId, previous.run.id)
                : [],
            )
        );
      };
      const isCurrent = () => connectionCurrent() && bindingCurrent();
      const assertBindingCurrent = () => {
        if (!isCurrent() || (exportRuns && !this.deps.store.haveExclusiveExportReceipts(exportRuns.runs)))
          throw new DiagnosticServiceError('expired');
      };
      const checkHistory = (history: NonNullable<DiagnosticReport['history']>) => {
        this.snapshot(query, owner);
        if (!isCurrent()) {
          history.status = 'changed';
          history.reason = 'history_changed';
          history.failures = [];
          delete history.lastResponse;
        }
        return history;
      };
      const publishHistory = (history: NonNullable<DiagnosticReport['history']>) => {
        if (options.signal?.aborted) return;
        try {
          options.onHistory?.({ snapshotId: query.snapshotId, history });
        } catch {
          // Optional presentation notifications must not discard collected evidence.
        }
      };
      const { stagingDirectory } = options;
      const contextTask = stagingDirectory
        ? sessionIdentityTask.then(nativeSessionId =>
            collectDiagnosticExportContext(
              isCurrent() ? client : null,
              nativeSessionId && binding ? { ...binding, nativeSessionId } : binding,
              stagingDirectory,
              options.signal,
            ),
          )
        : Promise.resolve(undefined);
      const physicalSessionTask = sessionIdentityTask.then(async describedId =>
        describedId ?? binding?.nativeSessionId ?? (await contextTask)?.nativeSessionId,
      );
      const requestsTask = exportLogs
        ? physicalSessionTask.then(nativeSessionId =>
            new DiagnosticExportRequests({
              sessionKey,
              nativeSessionId,
              selectedRunIds: nativeRunIds,
              runIds: exportRuns?.runs.flatMap(run => run.nativeRunIds),
            }),
          )
        : Promise.resolve(undefined);
      const logsTask = (async () => {
        let native: NativeDiagnosticLogs | undefined;
        if (options.signal?.aborted) {
          native = { failure: 'canceled' };
        } else if (client) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const controller = new AbortController();
          let failure: 'read_timeout' | 'canceled' | undefined;
          let cancel: (() => void) | undefined;
          try {
            const deadline = new Promise<never>((_, reject) => {
              const stop = (reason: 'read_timeout' | 'canceled') => {
                failure = reason;
                const error = new Error(reason);
                controller.abort(error);
                reject(error);
              };
              cancel = () => stop('canceled');
              options.signal?.addEventListener('abort', cancel, { once: true });
              timer = setTimeout(() => stop('read_timeout'), 3000);
            });
            const response = await Promise.race([
              client.request<{ lines?: unknown; truncated?: unknown; file?: unknown }>(
                'logs.tail',
                {
                  limit: 1000,
                  maxBytes: 524288,
                },
                { signal: controller.signal },
              ),
              deadline,
            ]);
            clearTimeout(timer);
            if (options.signal?.aborted) {
              native = { failure: 'canceled' };
            } else if (!connectionCurrent()) {
              native = { failure: 'source_changed' };
            } else if (!Array.isArray(response?.lines)) {
              native = { failure: 'unreadable' };
            } else {
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
                const message = error instanceof Error ? error.message : '';
                native.failure =
                  message === 'unsafe_file' || message === 'read_timeout' || message === 'canceled'
                    ? message
                    : 'unreadable';
              }
            }
          } catch {
            native = {
              failure: failure ?? (connectionCurrent() ? 'unreadable' : 'source_changed'),
            };
          } finally {
            clearTimeout(timer);
            if (cancel) options.signal?.removeEventListener('abort', cancel);
          }
          if (options.signal?.aborted) native = { failure: 'canceled' };
          else if (!connectionCurrent()) native = { failure: 'source_changed' };
        }
        const sources = { main: [] as string[], cowork: [] as string[], gateway: [] as string[] };
        const failedSources = new Set<string>();
        for (const source of ['main', 'cowork', 'gateway'] as const) {
          try {
            sources[source] = this.deps.logSources?.[source](previous) ?? [];
          } catch {
            failedSources.add(source);
          }
        }
        const requests = await requestsTask;
        const nativeSessionId = await physicalSessionTask;
        const logs = await collectDiagnosticLogs(previous, sources, native, {
          fullScan: true,
          nativeRunIds,
          nativeSessionKey: sessionKey,
          nativeSessionId,
          onNativeRecord: requests
            ? (fields, timestamp) => requests.append(fields, timestamp)
            : undefined,
          onExportRecord: exportLogs
            ? (source, text, association, metadata) =>
                exportLogs.append(source, text, association, metadata)
            : undefined,
          signal: options.signal,
          onProgress: progress =>
            options.onProgress?.({ ...progress, snapshotId: query.snapshotId }),
        });
        for (const coverage of logs.sources) {
          if (failedSources.has(coverage.source)) {
            coverage.status = 'unavailable';
            coverage.reasons = ['unreadable'];
          }
        }
        return logs;
      })();
      // The export's two history readers must use the same physical instance,
      // even when only the context reader can establish it.
      const historyTask = physicalSessionTask
        .then(expectedId => {
          const canReadHistory = isCurrent() && (!exportLogs || !client || expectedId);
          return collectDiagnosticHistory(
            previous,
            client,
            canReadHistory ? sessionKey : null,
            options.signal,
            nativeRunIds,
            expectedId,
          );
        })
        .then(history => {
          checkHistory(history);
          publishHistory(history);
          return history;
        });
      const artifactTask = Promise.resolve().then(() =>
        this.deps.getRuntimeArtifact?.(options.signal),
      );
      const localDetailsTask = Promise.resolve().then(() =>
        exportLogs && !options.signal?.aborted
          ? this.deps.getExportSessionDetails?.(previous.sessionId, previous.run?.id)
          : undefined,
      );
      const sessionDetailsTask = Promise.resolve().then(async () => {
        const localDetails = await localDetailsTask;
        if (!localDetails || options.signal?.aborted || !isCurrent()) return;
        const collectedAt = this.now();
        const verifiedSessionId = await sessionIdentityTask;
        if (!isCurrent()) return;
        const native = await collectDiagnosticSessionUsage(binding, client, verifiedSessionId, options.signal);
        return { ...localDetails, collectedAt, native };
      });
      const pluginsTask = this.deps.getPluginInventorySources && exportLogs
        ? localDetailsTask.catch((): undefined => undefined).then(localDetails => collectDiagnosticPluginInventory({
            ...this.deps.getPluginInventorySources?.(),
            client,
            agentId: localDetails?.session.agentId,
            sessionKey,
          }, options.signal))
        : Promise.resolve(undefined);
      // Keep the busy guard and snapshot pin until every independent task settles.
      const [
        logResult, historyResult, artifactResult, sessionDetailsResult, contextResult, pluginsResult,
        requestsResult, identityResult,
      ] = await Promise.allSettled([
        logsTask, historyTask, artifactTask, sessionDetailsTask, contextTask, pluginsTask, requestsTask,
        sessionIdentityTask,
      ]);
      if (logResult.status === 'rejected') throw logResult.reason;
      if (historyResult.status === 'rejected') throw historyResult.reason;
      const logs = logResult.value;
      const history = checkHistory(historyResult.value);
      if (contextResult.status === 'rejected') throw contextResult.reason;
      const context = contextResult.value;
      if (identityResult.status === 'rejected') throw identityResult.reason;
      const verifiedNativeSession = Boolean(identityResult.value);
      if (
        context?.coverage.reasons.includes('native_instance_changed') &&
        (verifiedNativeSession || binding?.nativeSessionId)
      ) {
        throw new DiagnosticServiceError('expired');
      }
      if (!isCurrent()) {
        publishHistory(history);
      }
      // Export-only content must not escape after its connection or receipt ownership changes.
      if (exportLogs) assertBindingCurrent();
      if (!bindingCurrent()) {
        logs.records = [];
        for (const source of logs.sources) {
          source.scanComplete = false;
          if (source.status !== 'unavailable') source.status = 'partial';
          if (!source.reasons.includes('source_changed')) source.reasons.push('source_changed');
          source.emitted = 0;
          source.matched = 0;
          source.signalCounts = {};
          source.outputOmitted = 0;
        }
      }
      if (!connectionCurrent()) runtimeInfo.gateway = { status: 'changed' };
      if (artifactResult.status === 'fulfilled')
        runtimeInfo.installedArtifact = artifactResult.value;
      const report = { ...previous, snapshotId: randomUUID(), logs, history, runtimeInfo };
      this.remember(report, owner);
      const assertExportCurrent = () => {
        this.assertSession({ sessionId: previous.sessionId });
        if (previous.run && !this.deps.store.getRun(previous.sessionId, previous.run.id))
          throw new DiagnosticServiceError('missing');
        assertBindingCurrent();
      };
      return {
        report,
        sessionDetails:
          sessionDetailsResult.status === 'fulfilled' ? sessionDetailsResult.value : undefined,
        detailEvidence: exportLogs ? {
          runs: exportRuns,
          requests: requestsResult.status === 'fulfilled' ? requestsResult.value : undefined,
          requestSessionIdentity: verifiedNativeSession
            ? 'gateway_describe' as const
            : binding?.nativeSessionId
              ? 'saved_history_binding' as const
              : context?.nativeSessionId ? 'gateway_chat_history' as const : undefined,
          context,
          plugins: pluginsResult.status === 'fulfilled' ? pluginsResult.value : undefined,
        } : undefined,
        assertExportCurrent,
      };
    } finally {
      this.collecting.delete(owner);
      this.pinnedSnapshots.delete(query.snapshotId);
    }
  }
}
