import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../../../../scripts/patches/v2026.7.1-2/013-atomic-sessions-spawn-admission.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

type SpawnResult = { status: 'accepted' | 'error' | 'forbidden'; error?: string };
type SpawnRuntime = {
  createSessionsSpawnTool: (options: { agentSessionKey?: string }) => {
    execute: (toolCallId: string, args: Record<string, unknown>) => Promise<SpawnResult>;
  };
  readState: () => { active: Record<string, number>; admissionPeak: number };
  reset: () => void;
  setMaxChildren: (value: number) => void;
};

const temporaryRoots: string[] = [];

const FIXTURE_SOURCE = `
const state = {
  activeChildren: new Map(),
  admissionActive: 0,
  admissionPeak: 0,
  maxChildren: 1,
  nextChild: 0
};
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function getRuntimeConfig() {
  return { agents: { defaults: { subagents: { maxChildrenPerAgent: state.maxChildren } } } };
}
function resolveMainSessionAlias() { return { mainKey: "main", alias: "agent:main:main" }; }
function resolveInternalSessionKey({ key, alias, mainKey }) {
  return key === mainKey || key === "main" ? alias : key;
}
function canonicalRequester(sessionKey) {
  const cfg = getRuntimeConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  return sessionKey ? resolveInternalSessionKey({ key: sessionKey, alias, mainKey }) : alias;
}
function countActiveRunsForSession(sessionKey) { return state.activeChildren.get(sessionKey) ?? 0; }
function registerActiveChild(sessionKey) {
  state.activeChildren.set(sessionKey, countActiveRunsForSession(sessionKey) + 1);
}
async function crossRegistrationWindow() {
  state.admissionActive += 1;
  state.admissionPeak = Math.max(state.admissionPeak, state.admissionActive);
  await delay(15);
  state.admissionActive -= 1;
}
function jsonResult(value) { return value; }
function addRoleToFailureResult(value) { return value; }
function setMaxChildren(value) { state.maxChildren = value; }
function reset() {
  state.activeChildren.clear();
  state.admissionActive = 0;
  state.admissionPeak = 0;
  state.nextChild = 0;
}
function readState() {
  return { active: Object.fromEntries(state.activeChildren), admissionPeak: state.admissionPeak };
}
async function spawnSubagentDirect(params, ctx) {
  const cfg = getRuntimeConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey ? resolveInternalSessionKey({
    key: requesterSessionKey,
    alias,
    mainKey
  }) : alias;
  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) return {
    status: "forbidden",
    error: \`sessions_spawn has reached max active children for this session (\${activeChildren}/\${maxChildren})\`
  };
  if (params.invalidPolicy) return { status: "forbidden", error: "invalid native policy" };
  const plan = params.invalidModel ? { status: "error", error: "invalid native model" } : { status: "ok" };
  if (plan.status === "error") return {
    status: "error",
    error: plan.error
  };
  const { resolvedModel, thinkingOverride } = plan;
  const patchChildSession = async () => {
    await crossRegistrationWindow();
  };
  const initialPatchError = await patchChildSession({});
  if (initialPatchError) return { status: "error", error: initialPatchError };
  if (params.fail) return { status: "error", error: "native initialization failed" };
  registerActiveChild(requesterInternalKey);
  return { status: "accepted", childSessionKey: \`native-\${++state.nextChild}\` };
}

async function spawnAcpDirect(params, ctx) {
  await crossRegistrationWindow();
  if (params.fail) return { status: "error", error: "ACP initialization failed" };
  return {
    status: "accepted",
    childSessionKey: \`acp-\${++state.nextChild}\`,
    runId: \`run-\${state.nextChild}\`
  };
}
async function loadAcpSpawnModule() { return { spawnAcpDirect }; }

function createSessionsSpawnTool(opts) {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    execute: async (_toolCallId, args) => {
      const params = args;
      const requestedAgentId = undefined;
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const attachments = Array.isArray(params.attachments) ? params.attachments : void 0;
      if (runtime === "acp") {
        const { spawnAcpDirect: spawnAcpDirect2 } = await loadAcpSpawnModule();
        const result = await spawnAcpDirect2({ fail: params.fail === true }, {
          agentSessionKey: opts?.agentSessionKey
        });
        if (result.status === "accepted") registerActiveChild(canonicalRequester(opts?.agentSessionKey));
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }
      return jsonResult(addRoleToFailureResult(await spawnSubagentDirect({
        fail: params.fail === true,
        invalidPolicy: params.invalidPolicy === true,
        invalidModel: params.invalidModel === true,
        attachments
      }, {
        agentSessionKey: opts?.agentSessionKey,
        inheritedToolAllowlist: opts?.inheritedToolAllowlist,
        inheritedToolDenylist: opts?.inheritedToolDenylist
      }), requestedAgentId));
    }
  };
}

module.exports = { createSessionsSpawnTool, readState, reset, setMaxChildren };
`;

function createRuntimeRoot(options: { bundle?: boolean; malformedBundle?: boolean } = {}): {
  root: string;
  sourcePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-v202671-spawn-admission-'));
  temporaryRoots.push(root);
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const sourcePath = path.join(distDir, 'openclaw-tools.js');
  fs.writeFileSync(sourcePath, FIXTURE_SOURCE, 'utf8');
  if (options.bundle) {
    const bundleSource = options.malformedBundle
      ? FIXTURE_SOURCE.replace(
          '      }), requestedAgentId));\n    }\n  };\n}',
          '      }), requestedAgentId));\n    }\n  };\n// missing function close',
        )
      : FIXTURE_SOURCE;
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundleSource, 'utf8');
  }
  return { root, sourcePath };
}

function loadRuntime(sourcePath: string): SpawnRuntime {
  const fixtureModule = { exports: {} as SpawnRuntime };
  const loadFixture = new Function('module', 'exports', fs.readFileSync(sourcePath, 'utf8'));
  loadFixture(fixtureModule, fixtureModule.exports);
  return fixtureModule.exports;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenClaw v2026.7.1-2 atomic sessions_spawn admission', () => {
  test('records pristine failure evidence for concurrent native calls from one requester', async () => {
    const { sourcePath } = createRuntimeRoot();
    const pristine = loadRuntime(sourcePath);
    const tool = pristine.createSessionsSpawnTool({ agentSessionKey: 'agent:main:parent' });

    const results = await Promise.all([tool.execute('native-1', {}), tool.execute('native-2', {})]);

    expect(results.map(result => result.status)).toEqual(['accepted', 'accepted']);
    expect(pristine.readState()).toEqual({
      active: { 'agent:main:parent': 2 },
      admissionPeak: 2,
    });
  });

  test('reserves native capacity atomically across aliases of one canonical requester', async () => {
    const { root, sourcePath } = createRuntimeRoot();
    expect(applyPatch(root)).toEqual([path.join('dist', 'openclaw-tools.js')]);
    verifyPatch(root);
    const runtime = loadRuntime(sourcePath);
    const aliasTool = runtime.createSessionsSpawnTool({ agentSessionKey: 'main' });
    const canonicalTool = runtime.createSessionsSpawnTool({ agentSessionKey: 'agent:main:main' });

    const results = await Promise.all([
      aliasTool.execute('native-alias', {}),
      canonicalTool.execute('native-canonical', {}),
    ]);

    expect(results.map(result => result.status)).toEqual(['accepted', 'forbidden']);
    expect(runtime.readState()).toEqual({
      active: { 'agent:main:main': 1 },
      admissionPeak: 1,
    });
  });

  test('keeps unrelated native requesters parallel and releases failed reservations', async () => {
    const { root, sourcePath } = createRuntimeRoot();
    applyPatch(root);
    const runtime = loadRuntime(sourcePath);
    const parentA = runtime.createSessionsSpawnTool({ agentSessionKey: 'agent:main:a' });
    const parentB = runtime.createSessionsSpawnTool({ agentSessionKey: 'agent:main:b' });

    const parallel = await Promise.all([parentA.execute('a', {}), parentB.execute('b', {})]);
    expect(parallel.map(result => result.status)).toEqual(['accepted', 'accepted']);
    expect(runtime.readState().admissionPeak).toBe(2);

    runtime.reset();
    const failed = await parentA.execute('failed', { fail: true });
    const acceptedAfterFailure = await parentA.execute('accepted', {});
    expect([failed.status, acceptedAfterFailure.status]).toEqual(['error', 'accepted']);
    expect(runtime.readState()).toEqual({
      active: { 'agent:main:a': 1 },
      admissionPeak: 1,
    });
  });

  test('does not let synchronous native preflight failures consume a valid reservation', async () => {
    const { root, sourcePath } = createRuntimeRoot();
    applyPatch(root);
    const runtime = loadRuntime(sourcePath);
    const tool = runtime.createSessionsSpawnTool({ agentSessionKey: 'agent:main:parent' });

    const policyResults = await Promise.all([
      tool.execute('invalid-policy', { invalidPolicy: true }),
      tool.execute('valid-after-policy', {}),
    ]);
    expect(policyResults.map(result => result.status)).toEqual(['forbidden', 'accepted']);

    runtime.reset();
    const modelResults = await Promise.all([
      tool.execute('invalid-model', { invalidModel: true }),
      tool.execute('valid-after-model', {}),
    ]);
    expect(modelResults.map(result => result.status)).toEqual(['error', 'accepted']);
    expect(runtime.readState()).toEqual({
      active: { 'agent:main:parent': 1 },
      admissionPeak: 1,
    });
  });

  test('leaves ACP concurrency unchanged and does not share in-flight native reservations', async () => {
    const { root, sourcePath } = createRuntimeRoot();
    const pristine = loadRuntime(sourcePath);
    const pristineAcp = pristine.createSessionsSpawnTool({ agentSessionKey: 'agent:main:acp' });
    const pristineResults = await Promise.all([
      pristineAcp.execute('acp-1', { runtime: 'acp' }),
      pristineAcp.execute('acp-2', { runtime: 'acp' }),
    ]);
    expect(pristineResults.map(result => result.status)).toEqual(['accepted', 'accepted']);
    expect(pristine.readState().admissionPeak).toBe(2);

    applyPatch(root);
    const patched = loadRuntime(sourcePath);
    const patchedTool = patched.createSessionsSpawnTool({ agentSessionKey: 'agent:main:mixed' });
    const patchedAcpResults = await Promise.all([
      patchedTool.execute('acp-1', { runtime: 'acp' }),
      patchedTool.execute('acp-2', { runtime: 'acp' }),
    ]);
    expect(patchedAcpResults.map(result => result.status)).toEqual(['accepted', 'accepted']);
    expect(patched.readState().admissionPeak).toBe(2);

    patched.reset();
    const mixedResults = await Promise.all([
      patchedTool.execute('native', {}),
      patchedTool.execute('acp', { runtime: 'acp' }),
    ]);
    expect(mixedResults.map(result => result.status)).toEqual(['accepted', 'accepted']);
    expect(patched.readState().admissionPeak).toBe(2);
  });

  test('patches source and bundle idempotently and verifies each independent guard', () => {
    const { root } = createRuntimeRoot({ bundle: true });

    expect(applyPatch(root)).toEqual([
      path.join('dist', 'openclaw-tools.js'),
      'gateway-bundle.mjs',
    ]);
    verifyPatch(root);
    expect(applyPatch(root)).toEqual([]);

    for (const relativePath of ['dist/openclaw-tools.js', 'gateway-bundle.mjs']) {
      const content = fs.readFileSync(path.join(root, relativePath), 'utf8');
      expect(content).toContain('function resolveNativeSessionsSpawnAdmissionKey(sessionKey) {');
      expect(content).toContain(
        'return rawSessionKey ? resolveInternalSessionKey({ key: rawSessionKey, alias, mainKey }) : alias;',
      );
      expect(content).toContain(
        'const nativeAdmissionReservation = ctx.reserveNativeSessionsSpawnAdmission?.();',
      );
      expect(content).toContain('reserveNativeSessionsSpawnAdmission: reserveNativeAdmission');
      expect(content).toContain(
        'releaseNativeSessionsSpawnAdmission(nativeSessionsSpawnAdmissionReservation);',
      );
      const acpBranch = content.indexOf('if (runtime === "acp") {');
      const nativeHolder = content.indexOf('let nativeSessionsSpawnAdmissionReservation;');
      expect(acpBranch).toBeGreaterThanOrEqual(0);
      expect(nativeHolder).toBeGreaterThan(acpBranch);
      expect(() => new Function('module', 'exports', content)).not.toThrow();
    }
  });

  test('stages all targets before writing when a bundle anchor is incomplete', () => {
    const { root, sourcePath } = createRuntimeRoot({ bundle: true, malformedBundle: true });
    const pristineSource = fs.readFileSync(sourcePath, 'utf8');

    expect(() => applyPatch(root)).toThrow(
      /public reservation release anchor count is 0, expected 1/,
    );
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(pristineSource);
    expect(fs.readFileSync(sourcePath, 'utf8')).not.toContain(
      'JUSTDO_ATOMIC_SESSIONS_SPAWN_ADMISSION_2026_7_1',
    );
  });

  test('rejects a partial 013 artifact instead of repairing it in place', () => {
    const { root, sourcePath } = createRuntimeRoot();
    applyPatch(root);
    const partial = fs
      .readFileSync(sourcePath, 'utf8')
      .replace(
        'releaseNativeSessionsSpawnAdmission(nativeSessionsSpawnAdmissionReservation);',
        '/* missing native admission release */',
      );
    fs.writeFileSync(sourcePath, partial, 'utf8');

    expect(() => applyPatch(root)).toThrow(/rejected a partial artifact/);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(partial);
  });

  test('rejects inconsistent source and bundle patch state without writing either target', () => {
    const { root, sourcePath } = createRuntimeRoot({ bundle: true });
    const bundlePath = path.join(root, 'gateway-bundle.mjs');
    applyPatch(root);
    fs.writeFileSync(bundlePath, FIXTURE_SOURCE, 'utf8');
    const patchedSource = fs.readFileSync(sourcePath, 'utf8');
    const pristineBundle = fs.readFileSync(bundlePath, 'utf8');

    expect(() => applyPatch(root)).toThrow(/inconsistent source\/bundle artifact/);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(patchedSource);
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(pristineBundle);
  });
});
