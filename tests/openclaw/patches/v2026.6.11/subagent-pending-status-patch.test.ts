import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../../../../scripts/patches/v2026.6.11/022-subagent-pending-status.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => boolean;
  };

type RuntimeFixture = {
  emitLifecycleStartBeforeRegistration: (runId: string, startedAt: number) => void;
  emitLifecycleStart: (runId: string, startedAt: number) => void;
  getRow: (runId: string) => {
    status?: string;
    subagentRunState?: string;
    startedAt?: number;
    runtimeMs?: number;
  };
  getToolStatus: (runId: string) => string | undefined;
  registerSubagentRun: (params: {
    runId: string;
    childSessionKey: string;
    requesterSessionKey: string;
  }) => void;
  registerAcpRun: (params: {
    runId: string;
    childSessionKey: string;
    requesterSessionKey: string;
  }) => void;
};

const temporaryRoots: string[] = [];

const FIXTURE_SOURCE = `
const subagentRuns = new Map();
let agentRunStarts;
agentRunStarts = /* @__PURE__ */ new Map();
let listener;
function resolveSubagentRunDurationMs() { return 1000; }
function asDateTimestampMs(value) { return value; }
function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  if (durationMs === void 0) return;
  const safeStartedAt = asDateTimestampMs(typeof observedStartedAt === "number" && Number.isFinite(observedStartedAt) ? observedStartedAt : typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) ? entry.startedAt : entry.createdAt);
  if (safeStartedAt === void 0) return;
  return safeStartedAt + durationMs;
}
function resolveSubagentSessionStartedAtInternal(entry) {
  if (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) return entry.sessionStartedAt;
  if (typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)) return entry.startedAt;
  return typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : void 0;
}
function getSubagentSessionStartedAt(entry) {
  return entry ? resolveSubagentSessionStartedAtInternal(entry) : void 0;
}
function getSubagentSessionRuntimeMs(entry, now = Date.now()) {
  if (!entry) return;
  const accumulatedRuntimeMs = typeof entry.accumulatedRuntimeMs === "number" ? entry.accumulatedRuntimeMs : 0;
  if (typeof entry.startedAt !== "number") return accumulatedRuntimeMs;
  return accumulatedRuntimeMs + Math.max(0, now - entry.startedAt);
}
function resolveSubagentSessionStatus(entry) {
  if (!entry) return;
  if (!entry.endedAt) return "running";
  return "done";
}
function hasSubagentRunEnded(entry) { return typeof entry.endedAt === "number"; }
function resolveRunStatus(entry) {
  if (!hasSubagentRunEnded(entry)) return "running";
  return "done";
}
function normalizeSubagentRunState(entry) { return entry; }
function persistSubagentRuns() {}
function clearPendingLifecycleError() {}
function clearPendingLifecycleTimeout() {}
function onAgentEvent(callback) { listener = callback; }
function ensureListener2() {
  onAgentEvent((evt) => {
    const phase = evt.data?.phase;
    const entry = subagentRuns.get(evt.runId);
    if (!entry) return;
    if (phase === "start") {
      clearPendingLifecycleError(evt.runId);
      clearPendingLifecycleTimeout(evt.runId);
        const startedAt3 = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : void 0;
        if (startedAt3) {
          entry.startedAt = startedAt3;
          if (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt3;
          persistSubagentRuns();
        }
        return;
    }
  });
}
function registerSubagentRun(params) {
  const registerParams = params;
  const runId = registerParams.runId.trim();
  const childSessionKey = registerParams.childSessionKey.trim();
  const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) return;
    const now = Date.now();
  const cfg = {};
  const runTimeoutSeconds = 0;
  const entry = normalizeSubagentRunState({
      runId,
      childSessionKey,
      requesterSessionKey,
      runTimeoutSeconds,
      createdAt: now,
      startedAt: now,
      execution: {
        status: "running",
        startedAt: now
      },
      completion: { required: false },
      delivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
      sessionStartedAt: now,
      accumulatedRuntimeMs: 0,
  });
  subagentRuns.set(runId, entry);
}
function registerAcpRun(input) {
  const result = { runTimeoutSeconds: 0 };
  const shouldExpectCompletionMessage = true;
  registerSubagentRun({
              runId: input.runId,
              childSessionKey: input.childSessionKey,
              requesterSessionKey: input.requesterSessionKey,
              runTimeoutSeconds: result.runTimeoutSeconds,
              expectsCompletionMessage: shouldExpectCompletionMessage,
  });
}
function buildRow(runId) {
  const subagentRun = subagentRuns.get(runId);
  const liveSubagentRunActive = Boolean(subagentRun && !subagentRun.endedAt);
  const subagentRunState = subagentRun ? liveSubagentRunActive ? "active" : "historical" : void 0;
  const subagentStatus = subagentRun ? liveSubagentRunActive ? resolveSubagentSessionStatus(subagentRun) : "done" : void 0;
  return {
    status: subagentStatus,
    subagentRunState,
    startedAt: getSubagentSessionStartedAt(subagentRun),
    runtimeMs: getSubagentSessionRuntimeMs(subagentRun)
  };
}
function emitLifecycleStart(runId, startedAt) {
  const evt = { runId, stream: "lifecycle", data: { phase: "start", startedAt } };
  agentRunStarts.set(evt.runId, startedAt);
  listener(evt);
}
function emitLifecycleStartBeforeRegistration(runId, startedAt) {
  const evt = { runId, stream: "lifecycle", data: { phase: "start", startedAt } };
  agentRunStarts.set(evt.runId, startedAt);
  listener(evt);
}
function getRow(runId) { return buildRow(runId); }
function getToolStatus(runId) { return resolveRunStatus(subagentRuns.get(runId)); }
ensureListener2();
module.exports = { emitLifecycleStart, emitLifecycleStartBeforeRegistration, getRow, getToolStatus, registerAcpRun, registerSubagentRun };
`;

function createPatchedFixture(): { runtimeDir: string; runtime: RuntimeFixture } {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-subagent-pending-'));
  temporaryRoots.push(runtimeDir);
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  fs.writeFileSync(bundlePath, FIXTURE_SOURCE, 'utf8');
  expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
  expect(verifyPatch(runtimeDir)).toBe(true);
  const fixtureModule = { exports: {} as RuntimeFixture };
  new Function('module', 'exports', fs.readFileSync(bundlePath, 'utf8'))(
    fixtureModule,
    fixtureModule.exports,
  );
  return { runtimeDir, runtime: fixtureModule.exports };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('subagent pending status patch', () => {
  test('keeps an accepted run pending until lifecycle start', () => {
    const { runtimeDir, runtime } = createPatchedFixture();
    runtime.registerSubagentRun({
      runId: 'run-1',
      childSessionKey: 'agent:main:subagent:child-1',
      requesterSessionKey: 'agent:main:parent',
    });

    expect(runtime.getRow('run-1')).toMatchObject({
      status: 'pending',
      subagentRunState: 'pending',
      runtimeMs: 0,
    });
    expect(runtime.getRow('run-1').startedAt).toBeUndefined();
    expect(runtime.getToolStatus('run-1')).toBe('pending');

    runtime.emitLifecycleStart('run-1', 1234);

    expect(runtime.getRow('run-1')).toMatchObject({
      status: 'running',
      subagentRunState: 'active',
      startedAt: 1234,
    });
    expect(runtime.getToolStatus('run-1')).toBe('running');
    expect(applyPatch(runtimeDir)).toEqual([]);
  });

  test('recovers a lifecycle start that arrives before registry admission', () => {
    const { runtime } = createPatchedFixture();
    runtime.emitLifecycleStartBeforeRegistration('run-early', 5678);

    runtime.registerSubagentRun({
      runId: 'run-early',
      childSessionKey: 'agent:main:subagent:child-early',
      requesterSessionKey: 'agent:main:parent',
    });

    expect(runtime.getRow('run-early')).toMatchObject({
      status: 'running',
      subagentRunState: 'active',
      startedAt: 5678,
    });
    expect(runtime.getToolStatus('run-early')).toBe('running');
  });

  test('keeps an accepted ACP child pending until its lane lifecycle starts', () => {
    const { runtime } = createPatchedFixture();

    runtime.registerAcpRun({
      runId: 'run-acp',
      childSessionKey: 'agent:main:subagent:child-acp',
      requesterSessionKey: 'agent:main:parent',
    });

    expect(runtime.getRow('run-acp')).toMatchObject({
      status: 'pending',
      subagentRunState: 'pending',
    });
    expect(runtime.getRow('run-acp').startedAt).toBeUndefined();

    runtime.emitLifecycleStart('run-acp', 9012);

    expect(runtime.getRow('run-acp')).toMatchObject({
      status: 'running',
      subagentRunState: 'active',
      startedAt: 9012,
    });
  });

  test('fails verification when the upstream registry anchors are absent', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-pending-missing-'));
    temporaryRoots.push(runtimeDir);
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'export {};\n', 'utf8');

    expect(applyPatch(runtimeDir)).toEqual([]);
    expect(() => verifyPatch(runtimeDir)).toThrow(/patch is incomplete/i);
  });

  test('fails verification when the bundle no longer exposes the early-start cache', () => {
    const { runtimeDir } = createPatchedFixture();
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const withoutCacheInitialization = fs
      .readFileSync(bundlePath, 'utf8')
      .replace('agentRunStarts = /* @__PURE__ */ new Map();', 'agentRunStarts = new Map();');
    fs.writeFileSync(bundlePath, withoutCacheInitialization, 'utf8');

    expect(() => verifyPatch(runtimeDir)).toThrow(/patch is incomplete/i);
  });

  test('removes the legacy ACP accepted-at registration timestamp', () => {
    const { runtimeDir } = createPatchedFixture();
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const current = fs.readFileSync(bundlePath, 'utf8');
    const legacy = current.replace(
      `              runTimeoutSeconds: result.runTimeoutSeconds,
              expectsCompletionMessage: shouldExpectCompletionMessage,`,
      `              runTimeoutSeconds: result.runTimeoutSeconds,
              executionStartedAt: Date.now(),
              expectsCompletionMessage: shouldExpectCompletionMessage,`,
    );
    fs.writeFileSync(bundlePath, legacy, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(fs.readFileSync(bundlePath, 'utf8')).not.toContain('executionStartedAt: Date.now(),');
    expect(verifyPatch(runtimeDir)).toBe(true);
  });

  test('fails atomically when one required upstream anchor drifts', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-pending-partial-'));
    temporaryRoots.push(runtimeDir);
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const drifted = FIXTURE_SOURCE.replace(
      'if (!hasSubagentRunEnded(entry)) return "running";',
      'if (!hasSubagentRunEnded(entry)) return "active";',
    );
    fs.writeFileSync(bundlePath, drifted, 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow(/partially applied/i);
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(drifted);
  });
});
