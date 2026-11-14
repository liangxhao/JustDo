import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { DiagnosticExportRequests } from './exportRequests';
import { collectDiagnosticLogs } from './logCollector';

const capture = () =>
  new DiagnosticExportRequests({
    sessionKey: 'agent:main:private-key',
    nativeSessionId: 'physical-session',
    selectedRunIds: ['selected-run'],
    runIds: ['previous-run'],
  });
const request = (value: Record<string, unknown> = {}) => ({
  type: 'runtime_services.model_call',
  phase: 'started',
  sessionKey: 'agent:main:private-key',
  sessionId: 'physical-session',
  runId: 'selected-run',
  callId: 'selected-run:model:1',
  traceId: '1'.repeat(32),
  spanId: '1'.repeat(16),
  provider: 'private-model-provider',
  model: 'models/test/variant',
  ...value,
});
const aliaser = () => {
  const aliases = new Map<string, string>();
  return (value: unknown) => {
    if (typeof value !== 'string') return;
    if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
    return aliases.get(value);
  };
};

describe('diagnostic export model request evidence', () => {
  it('retains chronologically attributable lifecycle records and pairs by trace, not reused call ID', () => {
    const evidence = capture();
    evidence.append(
      [request({ phase: 'ended', outcome: 'completed', spanId: '2'.repeat(16) })],
      40,
    );
    evidence.append([request({ spanId: '2'.repeat(16) })], 30);
    evidence.append(
      [
        request({
          phase: 'ended',
          outcome: 'error',
          failureKind: 'timeout',
          durationMs: 8,
          requestPayloadBytes: 300,
          responseStreamBytes: 12,
          upstreamRequestIdHash: 'sha256:578fcb098ec2',
          error: 'private-body',
        }),
      ],
      20,
    );
    evidence.append([request({ contextTokenBudget: 2048, contextWindowSource: 'model' })], 10);
    evidence.append(
      [
        request({
          type: 'model.call.completed',
          observationUnit: 'turn',
          runId: 'previous-run',
          traceId: undefined,
          spanId: undefined,
          usage: { input: 3, output: 5, total: 8, unsupported: 'private-tokens' },
        }),
      ],
      5,
    );
    const result = evidence.finish(aliaser());
    expect(result.coverage).toEqual({
      callObservations: 5,
      callObservationsOmitted: 0,
      fallbackObservations: 0,
      fallbackObservationsOmitted: 0,
    });
    expect(result.calls).toMatchObject([
      {
        source: 'native_diagnostic',
        unit: 'turn',
        association: 'conversation',
        observations: 'end_only',
        endedAt: 5,
        usage: { input: 3, output: 5, total: 8 },
      },
      {
        source: 'runtime_services',
        unit: 'request',
        association: 'selected_run',
        observations: 'start_and_end',
        startedAt: 10,
        endedAt: 20,
        outcome: 'error',
        model: 'models/test/variant',
        contextTokenBudget: 2048,
        failureKind: 'timeout',
        durationMs: 8,
        requestPayloadBytes: 300,
        responseStreamBytes: 12,
        upstreamRequestIdHash: 'sha256:578fcb098ec2',
      },
      {
        source: 'runtime_services',
        unit: 'request',
        association: 'selected_run',
        observations: 'start_and_end',
        startedAt: 30,
        endedAt: 40,
        outcome: 'completed',
      },
    ]);
    expect(result.calls[1].call).toBe(result.calls[2].call);
    expect(result.calls[1].span).not.toBe(result.calls[2].span);
    expect(JSON.stringify(result)).not.toMatch(
      /selected-run|physical-session|private-body|private-tokens/,
    );
  });

  it('requires exact current instance or exclusive run evidence and keeps fallback decisions separate', () => {
    const evidence = capture();
    evidence.append([request({ sessionKey: 'agent:other:foreign-key' })], 1);
    evidence.append([request({ sessionId: 'foreign-physical-id' })], 2);
    evidence.append([request(), { runId: 'conflicting-run' }], 3);
    evidence.append([request({ sessionId: undefined, runId: 'untrusted-run' })], 4);
    evidence.append(
      [request({ sessionKey: undefined, sessionId: undefined, runId: 'previous-run' })],
      5,
    );
    evidence.append(
      [
        {
          event: 'model_fallback_decision',
          runId: 'previous-run',
          decision: 'candidate_failed',
          attempt: 3,
          reason: 'rate_limit',
          status: 429,
          candidateProvider: 'provider',
          candidateModel: 'fallback/path',
          fallbackStepFinalOutcome: 'next_fallback',
          suppressedDuplicateCount: 2,
          errorPreview: 'private-body',
        },
      ],
      6,
    );
    const result = evidence.finish(aliaser());
    expect(result.calls).toMatchObject([
      { association: 'conversation', basis: 'exclusive_run_id', startedAt: 5 },
    ]);
    expect(result.coverage.unattributedNativeRecords).toBe(4);
    expect(result.fallbackDecisions).toMatchObject([
      {
        association: 'conversation',
        kind: 'model_fallback_decision',
        decision: 'candidate_failed',
        attempt: 3,
        reason: 'rate_limit',
        statusCode: 429,
        provider: 'provider',
        model: 'fallback/path',
        outcome: 'next_fallback',
        suppressedDuplicateCount: 2,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-body');
  });

  it('keeps the selected run under a noisy conversation and reports omitted lifecycle observations', () => {
    const evidence = capture();
    evidence.append([request()], 1);
    for (let at = 2; at < 700; at++) {
      evidence.append([request({ runId: 'previous-run', traceId: undefined })], at);
    }
    const result = evidence.finish(aliaser());
    expect(result.calls).toHaveLength(512);
    expect(result.calls[0]).toMatchObject({ association: 'selected_run', startedAt: 1 });
    expect(result.calls[1].startedAt).toBe(189);
    expect(result.coverage.callObservationsOmitted).toBe(187);
  });

  it('collects earlier native-run request evidence ahead of the selected raw-log filter', async () => {
    const now = Date.now();
    const report: DiagnosticReport = {
      version: 1,
      snapshotId: 'snapshot',
      sessionId: 'product-session',
      collectedAt: now,
      run: { id: 'selected-run', startedAt: now, state: 'running' },
      conclusion: { reason: 'running', confidence: 'confirmed', evidenceIds: [], toolFailures: 0 },
      coverage: { dropped: 0, storageFailed: false, partial: true },
      connection: 'connected',
      environment: { status: 'not_requested' },
      events: [],
    };
    const evidence = capture();
    const timestamp = now - 86400000;
    const raw: string[] = [];
    const logs = await collectDiagnosticLogs(
      report,
      { main: [], cowork: [], gateway: [] },
      {
        lines: [
          JSON.stringify({
            time: new Date(timestamp).toISOString(),
            '1': JSON.stringify(request({ runId: 'previous-run' })),
          }),
        ],
      },
      {
        fullScan: true,
        onNativeRecord: (fields, at) => evidence.append(fields, at),
        onExportRecord: (_source, text) => raw.push(text),
      },
    );
    expect(logs.records).toEqual([]);
    expect(raw).toEqual([]);
    expect(evidence.finish(aliaser()).calls).toMatchObject([
      { association: 'conversation', startedAt: timestamp },
    ]);
  });

  it.each([false, true])(
    'recovers unique native tail requests without replaying disk records (disk run evidence: %s)',
    async hasDiskRun => {
      const now = Date.now();
      const report: DiagnosticReport = {
        version: 1,
        snapshotId: 'snapshot',
        sessionId: 'product-session',
        collectedAt: now,
        run: { id: 'selected-run', startedAt: now, state: 'running' },
        conclusion: {
          reason: 'running',
          confidence: 'confirmed',
          evidenceIds: [],
          toolFailures: 0,
        },
        coverage: { dropped: 0, storageFailed: false, partial: true },
        connection: 'connected',
        environment: { status: 'not_requested' },
        events: [],
      };
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-request-'));
      try {
        const file = path.join(directory, 'native.log');
        const earlier = JSON.stringify({
          time: new Date(now - 86400000).toISOString(),
          '1': request({ runId: 'previous-run' }),
        });
        const latest = JSON.stringify({
          time: new Date(now).toISOString(),
          runId: 'selected-run',
          level: 'error',
          errorCategory: 'timeout',
        });
        const newestRequest = JSON.stringify({
          time: new Date(now + 1).toISOString(),
          '1': request({ callId: 'selected-run:model:2' }),
        });
        await fs.writeFile(file, hasDiskRun ? `${earlier}\n${latest}` : earlier);
        const evidence = capture();
        const raw: string[] = [];
        const logs = await collectDiagnosticLogs(
          report,
          { main: [], cowork: [], gateway: [] },
          {
            files: [file, path.join(directory, 'missing.log')],
            lines: [earlier, latest, newestRequest],
          },
          {
            fullScan: true,
            onNativeRecord: (fields, at) => evidence.append(fields, at),
            onExportRecord: (_source, text) => raw.push(text),
          },
        );
        expect(logs.sources[3]).toMatchObject({
          scanComplete: false,
          reasons: expect.arrayContaining(['missing']),
        });
        expect(raw).toEqual(hasDiskRun ? [latest] : [newestRequest, latest]);
        const requests = evidence.finish(aliaser());
        expect(requests.coverage.callObservations).toBe(2);
        expect(requests.calls).toMatchObject([
          { association: 'conversation', startedAt: now - 86400000 },
          { association: 'selected_run', startedAt: now + 1 },
        ]);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
});
