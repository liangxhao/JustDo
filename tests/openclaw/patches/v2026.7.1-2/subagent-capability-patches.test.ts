import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const pendingLifecyclePatch =
  require('../../../../scripts/patches/v2026.7.1-2/014-subagent-pending-lifecycle.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
  };

const temporaryRoots: string[] = [];

function createRuntime(): string {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-subagent-capabilities-'));
  temporaryRoots.push(runtimeRoot);
  fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{"type":"module"}');
  return runtimeRoot;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw v2026.7.1-2 subagent capability patches', () => {
  test('projects accepted work as pending and transitions it only on lifecycle start', async () => {
    const runtimeRoot = createRuntime();
    const detachedTaskPath = path.join(runtimeRoot, 'dist', 'detached-task-runtime-B93mVzDV.js');
    const registryPath = path.join(runtimeRoot, 'dist', 'subagent-registry.js');
    const statePath = path.join(runtimeRoot, 'dist', 'subagent-registry-state.js');
    const listPath = path.join(runtimeRoot, 'dist', 'subagent-list.js');
    fs.writeFileSync(
      detachedTaskPath,
      `export const a = () => {};
export const d = () => {};
export const i = () => true;
export const n = () => {};
export const o = () => {};
export const r = () => true;
export const s = () => {};
export const u = () => {};
`,
    );
    fs.writeFileSync(
      registryPath,
      `import { a as failTaskRunByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId, o as finalizeTaskRunByRunId, s as findDetachedTaskRun, u as setDetachedTaskDeliveryStatusByRunId } from "./detached-task-runtime-B93mVzDV.js";
function createSubagentRunManager(params) {
  const replaceSubagentRunAfterSteer = (replaceParams) => {
    const source = {};
    const nextRunId = replaceParams.nextRunId;
    const now = Date.now();
\t\tconst sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
\t\tconst accumulatedRuntimeMs = getSubagentSessionRuntimeMs(source, typeof source.endedAt === "number" ? source.endedAt : now) ?? 0;
    const next = normalizeSubagentRunState({
\t\t\tcreatedAt: now,
\t\t\tstartedAt: now,
\t\t\tsessionStartedAt,
\t\t\taccumulatedRuntimeMs,
\t\t\texecution: {
\t\t\t\tstatus: "running",
\t\t\t\tstartedAt: now,
\t\t\t\ttranscriptFile: replaceParams.transcriptFile
\t\t\t},
    });
    return next;
  };
\tconst registerSubagentRun = (registerParams) => {
\t\tconst runId = registerParams.runId.trim();
\t\tconst childSessionKey = registerParams.childSessionKey.trim();
\t\tconst requesterSessionKey = registerParams.requesterSessionKey.trim();
    const controllerSessionKey = requesterSessionKey;
\t\tif (!runId || !childSessionKey || !requesterSessionKey) return;
\t\tconst now = Date.now();
\t\tconst generation = nextSubagentRunGeneration(params.runs.values(), childSessionKey);
    const entry = normalizeSubagentRunState({
      runId, childSessionKey, requesterSessionKey, controllerSessionKey, generation,
\t\t\tcreatedAt: now,
\t\t\tstartedAt: now,
\t\t\texecution: {
\t\t\t\tstatus: "running",
\t\t\t\tstartedAt: now
\t\t\t},
      completion: {},
\t\t\tdelivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
\t\t\tsessionStartedAt: now,
\t\t\taccumulatedRuntimeMs: 0,
    });
\t\ttry {
\t\t\tif (!createRunningTaskRun({
        runtime: "subagent", runId, childSessionKey,
\t\t\t\tdeliveryStatus: registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
\t\t\t\tstartedAt: now,
\t\t\t\tlastEventAt: now
      })) throw new Error("task");
    } catch {}
    return entry;
  };
  return { registerSubagentRun, replaceSubagentRunAfterSteer };
}
const subagentRuns = new Map();
let listenerStarted = false;
const subagentRegistryDeps = { onAgentEvent() {} };
function ensureListener() {
  if (listenerStarted) return;
  listenerStarted = true;
  subagentRegistryDeps.onAgentEvent((evt) => {
    (async () => {
\t\t\tif (!evt || evt.stream !== "lifecycle") return;
\t\t\tconst phase = evt.data?.phase;
\t\t\tconst entry = subagentRuns.get(evt.runId);
\t\t\tif (!entry) {
\t\t\t\tif (phase === "end" && typeof evt.sessionKey === "string") await refreshFrozenResultFromSession(evt.sessionKey);
\t\t\t\treturn;
\t\t\t}
\t\t\tif (phase === "start") {
\t\t\t\tclearPendingLifecycleError(evt.runId);
\t\t\t\tclearPendingLifecycleTimeout(evt.runId);
\t\t\t\tconst startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : void 0;
\t\t\t\tif (startedAt) {
\t\t\t\t\tentry.startedAt = startedAt;
\t\t\t\t\tif (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt;
\t\t\t\t\tpersistSubagentRuns();
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}
    })();
  });
}
export { buildJustDoSubagentAdmissionState, markJustDoSubagentLifecycleStarted };
`,
    );
    fs.writeFileSync(
      statePath,
      `function resolveSubagentRunDurationMs(value) { return value * 1000; }
function asDateTimestampMs(value) { return value; }
function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
\tconst durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  const safeStartedAt = observedStartedAt ?? entry.startedAt ?? entry.createdAt;
  return safeStartedAt + durationMs;
}
function resolveSubagentSessionStartedAtInternal(entry) {
\tif (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) return entry.sessionStartedAt;
  if (typeof entry.startedAt === "number") return entry.startedAt;
  return entry.createdAt;
}
function resolveSubagentSessionStatus(entry) {
  if (!entry) return;
\tif (!entry.endedAt) return "running";
  return "done";
}
function buildExecutionState(entry) {
  if (typeof entry.endedAt === "number") return { status: "terminal" };
\treturn {
\t\tstatus: "running",
\t\tstartedAt: entry.startedAt
\t};
}
function buildCompletionState() { return {}; }
export { resolveSubagentRunDeadlineMs, resolveSubagentSessionStartedAtInternal, resolveSubagentSessionStatus, buildExecutionState };
`,
    );
    fs.writeFileSync(
      listPath,
      `function hasSubagentRunEnded(entry) { return typeof entry.endedAt === "number"; }
function resolveRunStatus(entry, options) {
  const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
  if (pendingDescendants > 0) return "active";
\tif (!hasSubagentRunEnded(entry)) return "running";
  return "done";
}
function buildSubagentList(params) { return params; }
export { resolveRunStatus };
`,
    );

    expect(pendingLifecyclePatch.applyPatch(runtimeRoot)).toEqual([
      path.join('dist', 'subagent-registry.js'),
      path.join('dist', 'subagent-registry-state.js'),
      path.join('dist', 'subagent-list.js'),
    ]);
    pendingLifecyclePatch.verifyPatch(runtimeRoot);
    const once = [registryPath, statePath, listPath].map(filePath => fs.readFileSync(filePath));
    const registry = (await import(`${pathToFileURL(registryPath).href}?test=${Date.now()}`)) as {
      buildJustDoSubagentAdmissionState: (
        startedAt: number | undefined,
        queuedAt: number,
      ) => {
        startedAt?: number;
        execution: { status: string; queuedAt?: number; startedAt?: number };
      };
      markJustDoSubagentLifecycleStarted: (
        entry: {
          startedAt?: number;
          sessionStartedAt?: number;
          execution: Record<string, unknown>;
        },
        startedAt: number,
      ) => void;
    };
    const state = (await import(`${pathToFileURL(statePath).href}?test=${Date.now()}`)) as {
      resolveSubagentRunDeadlineMs: (entry: Record<string, unknown>) => number | undefined;
      resolveSubagentSessionStartedAtInternal: (
        entry: Record<string, unknown>,
      ) => number | undefined;
      resolveSubagentSessionStatus: (entry: Record<string, unknown>) => string;
      buildExecutionState: (entry: Record<string, unknown>) => { status: string };
    };
    const list = (await import(`${pathToFileURL(listPath).href}?test=${Date.now()}`)) as {
      resolveRunStatus: (
        entry: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => string;
    };

    const admission = registry.buildJustDoSubagentAdmissionState(undefined, 1_000);
    expect(admission).toEqual({ execution: { status: 'pending', queuedAt: 1_000 } });
    const entry = { createdAt: 1_000, runTimeoutSeconds: 60, ...admission };
    expect(state.resolveSubagentRunDeadlineMs(entry)).toBeUndefined();
    expect(state.resolveSubagentSessionStartedAtInternal(entry)).toBeUndefined();
    expect(state.resolveSubagentSessionStatus(entry)).toBe('pending');
    expect(state.buildExecutionState(entry).status).toBe('pending');
    expect(list.resolveRunStatus(entry)).toBe('pending');

    registry.markJustDoSubagentLifecycleStarted(entry, 2_000);
    expect(entry).toMatchObject({
      startedAt: 2_000,
      sessionStartedAt: 2_000,
      execution: { status: 'running', startedAt: 2_000 },
    });
    expect(entry.execution).not.toHaveProperty('queuedAt');
    expect(state.resolveSubagentRunDeadlineMs(entry)).toBe(62_000);
    expect(state.resolveSubagentSessionStatus(entry)).toBe('running');
    expect(list.resolveRunStatus(entry)).toBe('running');
    expect(fs.readFileSync(registryPath, 'utf8')).toContain(
      'admittedRunStartedAt === void 0 ? createQueuedTaskRun : createRunningTaskRun',
    );
    expect(fs.readFileSync(registryPath, 'utf8')).toContain('startTaskRunByRunId({');

    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      [statePath, listPath].map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n'),
    );
    const bundleOnce = fs.readFileSync(bundlePath);
    expect(pendingLifecyclePatch.applyPatch(runtimeRoot)).toEqual([]);
    pendingLifecyclePatch.verifyPatch(runtimeRoot);
    expect([registryPath, statePath, listPath].map(filePath => fs.readFileSync(filePath))).toEqual(
      once,
    );
    expect(fs.readFileSync(bundlePath)).toEqual(bundleOnce);
  });
});
