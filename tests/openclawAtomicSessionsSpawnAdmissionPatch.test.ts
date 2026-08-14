import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../scripts/patches/v2026.6.11/021-atomic-sessions-spawn-admission.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => boolean;
  };

type SpawnResult = { status: string; error?: string };
type RuntimeFixture = {
  createSessionsSpawnTool: (options: {
    agentSessionKey: string;
    config: Record<string, unknown>;
  }) => { execute: (toolCallId: string, args: Record<string, unknown>) => Promise<SpawnResult> };
  setLimits: (maxConcurrent: number, maxChildrenPerAgent: number) => void;
  waitForRuns: () => Promise<void>;
  finishChildren: (sessionKey: string) => void;
  readState: () => { admissionPeak: number; runPeak: number };
};

const temporaryRoots: string[] = [];

const FIXTURE_SOURCE = `
const state = {
  activeChildren: new Map(),
  admissionActive: 0,
  admissionPeak: 0,
  runActive: 0,
  runPeak: 0,
  runQueue: [],
  pendingRuns: new Set(),
  maxConcurrent: 3,
  maxChildrenPerAgent: 5
};
const runtimeConfig = { agents: { defaults: { subagents: {} } } };

function setLimits(maxConcurrent, maxChildrenPerAgent) {
  state.maxConcurrent = maxConcurrent;
  state.maxChildrenPerAgent = maxChildrenPerAgent;
  runtimeConfig.agents.defaults.subagents.maxConcurrent = maxConcurrent;
  runtimeConfig.agents.defaults.subagents.maxChildrenPerAgent = maxChildrenPerAgent;
}
function getRuntimeConfig() { return runtimeConfig; }
function resolveMainSessionAlias() { return { mainKey: "main", alias: "main" }; }
function resolveInternalSessionKey({ key }) { return key; }
function countActiveRunsForSession(sessionKey) { return state.activeChildren.get(sessionKey) ?? 0; }
function jsonResult(value) { return value; }
function addRoleToFailureResult(value) { return value; }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function pumpRuns() {
  while (state.runActive < state.maxConcurrent && state.runQueue.length > 0) {
    const run = state.runQueue.shift();
    state.runActive += 1;
    state.runPeak = Math.max(state.runPeak, state.runActive);
    const pending = delay(40).then(() => {
      state.runActive -= 1;
      state.pendingRuns.delete(pending);
      pumpRuns();
    });
    state.pendingRuns.add(pending);
    run();
  }
}
function scheduleRun() {
  state.runQueue.push(() => {});
  pumpRuns();
}
async function waitForRuns() {
  while (state.runQueue.length > 0 || state.pendingRuns.size > 0) {
    await Promise.all([...state.pendingRuns]);
  }
}
function finishChildren(sessionKey) { state.activeChildren.set(sessionKey, 0); }
function readState() { return { admissionPeak: state.admissionPeak, runPeak: state.runPeak }; }

function createAcpSpawnFailure(value) { return value; }
const crypto48 = { randomUUID: () => String(Math.random()) };
const ACP_SPAWN_SESSION_ACCEPTED_NOTE = "session accepted";
const ACP_SPAWN_ACCEPTED_NOTE = "accepted";
function resolveAcpSpawnStreamPlan() { return { effectiveStreamToParent: false }; }
function prepareAcpThreadBinding() { return { ok: true, binding: {} }; }
function resolveAcpSessionMode(mode) { return mode; }
function resolveSpawnedWorkspaceInheritance() { return undefined; }
async function resolveRuntimeCwdForAcpSpawn() { await delay(1); return undefined; }

async function spawnAcpDirect(params, ctx) {
  if (params.invalidAcpPolicy) return createAcpSpawnFailure({ status: "forbidden", error: "invalid ACP policy" });
  const runtimeOptionsResult = { ok: true };
  if (!runtimeOptionsResult.ok) return createAcpSpawnFailure({
    status: "error",
    errorCode: "spawn_failed",
    error: runtimeOptionsResult.error
  });
  const spawnMode = "run";
  const requestThreadBinding = false;
  const requesterState = { origin: {} };
  const targetAgentId = "main";
  const effectiveStreamToParent = false;
  const sessionKey = \`agent:\${targetAgentId}:acp:\${crypto48.randomUUID()}\`;
  const runtimeMode = resolveAcpSessionMode(spawnMode);
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: runtimeConfig,
    targetAgentId,
    requesterSessionKey: ctx.agentSessionKey,
    explicitWorkspaceDir: params.cwd
  });
  let runtimeCwd;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd,
      explicitCwd: params.cwd
    });
  } catch (error51) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "cwd_resolution_failed",
      error: String(error51)
    });
  }
  let preparedBinding = null;
  if (requestThreadBinding) {
    const prepared = prepareAcpThreadBinding({
      cfg: runtimeConfig,
      channel: requesterState.origin?.channel,
      accountId: requesterState.origin?.accountId,
      to: requesterState.origin?.to,
      threadId: requesterState.origin?.threadId,
      groupId: ctx.agentGroupId
    });
    if (!prepared.ok) return createAcpSpawnFailure({
      status: "error",
      errorCode: "thread_binding_invalid",
      error: prepared.error
    });
    preparedBinding = prepared.binding;
  }
  let binding = null;
  state.admissionActive += 1;
  state.admissionPeak = Math.max(state.admissionPeak, state.admissionActive);
  await delay(5);
  state.admissionActive -= 1;
  if (params.fail) return { status: "error", error: "spawn failed" };
  state.activeChildren.set(ctx.agentSessionKey, countActiveRunsForSession(ctx.agentSessionKey) + 1);
  scheduleRun();
  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: sessionKey,
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE
  };
}
var DEFAULT_STREAM_FLUSH_MS;

async function spawnSubagentDirect(params, ctx) {
  if (params.invalidNativePolicy) return { status: "forbidden", error: "invalid native policy" };
  const plan = params.invalidModel ? { status: "error", error: "invalid model" } : { status: "ok" };
  if (plan.status === "error") return {
    status: "error",
    error: plan.error
  };
  const { resolvedModel, thinkingOverride } = plan;
  const attachmentsReceipt = undefined;
  state.admissionActive += 1;
  state.admissionPeak = Math.max(state.admissionPeak, state.admissionActive);
  await delay(5);
  state.admissionActive -= 1;
  if (params.fail) return { status: "error", error: "spawn failed" };
  const activeChildren = state.activeChildren.get(ctx.agentSessionKey) ?? 0;
  state.activeChildren.set(ctx.agentSessionKey, activeChildren + 1);
  scheduleRun();
  if (params.finishImmediately) state.activeChildren.set(ctx.agentSessionKey, activeChildren);
  return {
    status: "accepted",
    attachments: attachmentsReceipt
  };
}
async function loadAcpSpawnModule() { return { isSpawnAcpAcceptedResult: result => result.status === "accepted", spawnAcpDirect }; }

function createSessionsSpawnTool(opts) {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    execute: async (_toolCallId, args2) => {
      const params = args2;
      const requestedAgentId = undefined;
      const runtime3 = params.runtime === "acp" ? "acp" : "subagent";
      if (params.invalidTaskName === true) return jsonResult({
        status: "error",
        error: "invalid taskName"
      });
      const attachments = Array.isArray(params.attachments) ? params.attachments : void 0;
      if (runtime3 === "acp") {
        const { spawnAcpDirect: spawnAcpDirect2 } = await loadAcpSpawnModule();
        return jsonResult(await spawnAcpDirect2({
          fail: params.fail === true,
          invalidAcpPolicy: params.invalidAcpPolicy === true
        }, {
          agentSessionKey: opts?.agentSessionKey,
          inheritedToolDenylist: opts?.inheritedToolDenylist
        }));
      }
      return jsonResult(addRoleToFailureResult(await spawnSubagentDirect({
        fail: params.fail === true,
        finishImmediately: params.finishImmediately === true,
        invalidNativePolicy: params.invalidNativePolicy === true,
        invalidModel: params.invalidModel === true
      }, {
        agentSessionKey: opts?.agentSessionKey,
        inheritedToolDenylist: opts?.inheritedToolDenylist
      }), requestedAgentId));
    }
  };
}

setLimits(3, 5);
module.exports = { createSessionsSpawnTool, finishChildren, readState, setLimits, waitForRuns };
`;

function createPatchedFixture(): { runtimeDir: string; runtime: RuntimeFixture } {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-spawn-admission-'));
  temporaryRoots.push(runtimeDir);
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  fs.writeFileSync(bundlePath, FIXTURE_SOURCE, 'utf8');
  expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
  expect(verifyPatch(runtimeDir)).toBe(true);
  expect(fs.readFileSync(bundlePath, 'utf8')).toContain(
    'const configuredMaxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent;',
  );
  const fixtureModule = { exports: {} as RuntimeFixture };
  const loadFixture = new Function(
    'module',
    'exports',
    'require',
    fs.readFileSync(bundlePath, 'utf8'),
  );
  loadFixture(fixtureModule, fixtureModule.exports, require);
  const runtime = fixtureModule.exports;
  return { runtimeDir, runtime };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('atomic sessions_spawn admission patch', () => {
  test('accepts five parallel children, runs at most three, and rejects the rest', async () => {
    const { runtimeDir, runtime } = createPatchedFixture();
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) => tool.execute(`call-${index}`, {})),
    );
    await runtime.waitForRuns();

    expect(results.filter(result => result.status === 'accepted')).toHaveLength(5);
    expect(results.filter(result => result.status === 'forbidden')).toHaveLength(4);
    expect(results.find(result => result.status === 'forbidden')?.error).toContain(
      'wait for an active child to finish before retrying',
    );
    expect(runtime.readState()).toEqual({ admissionPeak: 1, runPeak: 3 });
    expect(applyPatch(runtimeDir)).toEqual([]);
  });

  test('reads configured limits instead of hardcoding the defaults', async () => {
    const { runtime } = createPatchedFixture();
    runtime.setLimits(1, 2);
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => tool.execute(`call-${index}`, {})),
    );
    await runtime.waitForRuns();

    expect(results.map(result => result.status)).toEqual([
      'accepted',
      'accepted',
      'forbidden',
      'forbidden',
    ]);
    expect(runtime.readState().runPeak).toBe(1);
  });

  test('reserves the first five arrivals even when accepted children finish immediately', async () => {
    const { runtime } = createPatchedFixture();
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        tool.execute(`fast-${index}`, {
          finishImmediately: true,
          taskName: 'same-name-is-allowed',
        }),
      ),
    );
    await runtime.waitForRuns();

    expect(results.filter(result => result.status === 'accepted')).toHaveLength(5);
    expect(results.filter(result => result.status === 'forbidden')).toHaveLength(4);
  });

  test('does not let native or ACP branch preflight failures consume valid reservations', async () => {
    const { runtime } = createPatchedFixture();
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });

    const nativeResults = await Promise.all([
      tool.execute('invalid-native', { invalidNativePolicy: true }),
      ...Array.from({ length: 5 }, (_, index) => tool.execute(`valid-${index}`, {})),
    ]);
    await runtime.waitForRuns();

    expect(nativeResults[0]).toEqual({ status: 'forbidden', error: 'invalid native policy' });
    expect(nativeResults.slice(1).filter(result => result.status === 'accepted')).toHaveLength(5);
    runtime.finishChildren('parent-a');

    const acpResults = await Promise.all([
      tool.execute('invalid-acp', { runtime: 'acp', invalidAcpPolicy: true }),
      ...Array.from({ length: 5 }, (_, index) =>
        tool.execute(`valid-acp-${index}`, { runtime: 'acp' }),
      ),
    ]);
    await runtime.waitForRuns();

    expect(acpResults[0]).toEqual({ status: 'forbidden', error: 'invalid ACP policy' });
    expect(acpResults.slice(1).filter(result => result.status === 'accepted')).toHaveLength(5);
    expect([...nativeResults, ...acpResults].filter(result => result.status === 'forbidden')).toHaveLength(
      2,
    );
  });

  test('fails closed when the configured child limit is outside the supported range', async () => {
    const { runtime } = createPatchedFixture();
    runtime.setLimits(1, 0);
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });

    const result = await tool.execute('invalid-limit', {});

    expect(result).toEqual({
      status: 'forbidden',
      error:
        'sessions_spawn requires agents.defaults.subagents.maxChildrenPerAgent to be an integer between 1 and 20',
    });
  });

  test('applies the same hard limit to parallel ACP and mixed runtime spawns', async () => {
    const { runtime } = createPatchedFixture();
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });

    const acpResults = await Promise.all(
      Array.from({ length: 9 }, (_, index) => tool.execute(`acp-${index}`, { runtime: 'acp' })),
    );
    expect(acpResults.filter(result => result.status === 'accepted')).toHaveLength(5);
    expect(acpResults.filter(result => result.status === 'forbidden')).toHaveLength(4);

    runtime.finishChildren('parent-a');
    const mixedResults = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        tool.execute(`mixed-${index}`, { runtime: index % 2 === 0 ? 'acp' : 'subagent' }),
      ),
    );
    await runtime.waitForRuns();

    expect(mixedResults.filter(result => result.status === 'accepted')).toHaveLength(5);
    expect(mixedResults.filter(result => result.status === 'forbidden')).toHaveLength(4);
  });

  test('isolates parent locks and releases them after failures and child completion', async () => {
    const { runtime } = createPatchedFixture();
    runtime.setLimits(1, 1);
    const parentA = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-a', config: {} });
    const parentB = runtime.createSessionsSpawnTool({ agentSessionKey: 'parent-b', config: {} });

    const [failed, acceptedB] = await Promise.all([
      parentA.execute('failed', { fail: true }),
      parentB.execute('accepted-b', {}),
    ]);
    const acceptedA = await parentA.execute('accepted-a', {});
    runtime.finishChildren('parent-a');
    const acceptedAfterCompletion = await parentA.execute('accepted-after-completion', {});
    await runtime.waitForRuns();

    expect(failed.status).toBe('error');
    expect(acceptedA.status).toBe('accepted');
    expect(acceptedB.status).toBe('accepted');
    expect(acceptedAfterCompletion.status).toBe('accepted');
    expect(runtime.readState().admissionPeak).toBe(2);
  });

  test('fails verification when the upstream sessions_spawn anchor is absent', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-spawn-admission-missing-'));
    temporaryRoots.push(runtimeDir);
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'export {};\n', 'utf8');

    expect(applyPatch(runtimeDir)).toEqual([]);
    expect(() => verifyPatch(runtimeDir)).toThrow(/patch is incomplete/i);
  });
});
