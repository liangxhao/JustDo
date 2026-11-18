import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/039-mcp-app-model-continuity.cjs');
const { functionRange } = require(
  '../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js',
);
const { transform, CONTRACT, NATIVE, FILES } = patch.__testing;
const fixture = `// RUNTIME_MCP_APP_SESSION_WORKSPACE_V2026_10_7
import { n as acquireSessionMcpRuntime } from "./agent-bundle-mcp-manager-api-MgM2jUv6.mjs";
function runtimeSelection(entry, model, harnessId) {
  return JSON.stringify([entry.pinnedHarness,model.provider,model.model,harnessId,entry.agentRuntimeOverride,entry.modelSelectionLocked,entry.providerOverride,entry.modelOverride,entry.authProfileOverride,entry.authProfileOverrideSource,entry.sandboxMode,entry.spawnedBy,entry.spawnedWorkspaceDir,entry.spawnedCwd]);
}
async function prepareMcpAppExtensionRuntime(options) {
  const access = options.sessionAccessAuthority;
  const projection = options.projection;
  const { agentId, sessionKey, sessionId } = access.target;
  const query = { agentId, key: sessionKey };
  const initial = projection.sharingTarget(query);
  const cfg = options.context.getRuntimeConfig();
  const selectRuntime = (entry) => {
    const model = resolveSessionSelectedModelRef({
      cfg,
      entry
    });
    const harnessId = resolveEffectiveAgentRuntime({
      cfg,
      model
    });
    return { model, harnessId, fingerprint: runtimeSelection(entry, model, harnessId) };
  };
  const selected = selectRuntime(initial.entry);
  const current = (assertAccess = access.assertCurrent) => {
    assertAccess();
    if (options.context.getRuntimeConfig() !== cfg) throw new Error("MCP App configuration changed; reopen the App");
    const target = projection.sharingTarget(query);
    if (selectRuntime(target.entry).fingerprint !== selected.fingerprint)
      throw new Error("MCP App session runtime selection changed; reopen the App");
    return target;
  };
  const target = current();
  const workspaceDir = options.workspaceDir;
  const { model: selectedModel, harnessId } = selected;
  const acquired = await acquireSessionMcpRuntime(options);
  const runtime = acquired.runtime;
  try {
    const assertTool = (tool, interaction = false, assertAccess = access.assertCurrent) => {
      const live = current(assertAccess);
      const policy = options.context.getRuntimeConfig();
      if (!policy.mcp.apps.enabled || !options.isAllowed(live.entry, policy, tool))
        throw new Error("tool denied by current policy");
      return interaction && tool.approval;
    };
    const approveTool = () => {};
    const retainViewAuthority = (viewTools) => {
      const retained = access.retain();
      const prepareToolCall = async (request) => {
        const tool = viewTools.find((candidate) => candidate.toolName === request.toolName);
        if (!tool) throw new Error("MCP App tool is not granted to this view");
        const assertCurrent = () => {
          request.assertCurrent();
          retained.assertCurrent();
          assertTool(tool, false, retained.assertCurrent);
        };
        assertCurrent();
        const approvalRequired = assertTool(tool, true, retained.assertCurrent);
        if (approvalRequired) await requestMcpAppToolApproval({
          options: request.options,
          agentId,
          sessionKey,
          serverName: tool.serverName,
          toolName: tool.toolName,
          input: request.input,
          view: request.view,
          requesterId: resolveMcpAppRequesterId(request.options.client),
          assertCurrent,
          signal: request.signal ? AbortSignal.any([retained.signal, request.signal]) : retained.signal
        });
        const assertExecutionCurrent = () => {
          assertCurrent();
          if (assertTool(tool, true, retained.assertCurrent) && !approvalRequired) throw new Error("MCP App approval policy changed before execution");
        };
        assertExecutionCurrent();
        return assertExecutionCurrent;
      };
      return {
        ...retained,
        prepareToolCall,
        assertCurrent: () => {
          retained.assertCurrent();
          if (current(retained.assertCurrent).entry.permissionMode !== target.entry.permissionMode) throw new Error("MCP App permission mode changed; reopen the App");
          for (const tool of viewTools) assertTool(tool, false, retained.assertCurrent);
        }
      };
    };
    return {
      approveTool,
      retainViewAuthority
    };
  } catch (error) {
    throw error;
  }
}
async function launch(active, tool, input, extra) {
  const result = await call(active, tool, input);
  const viewTools = appToolsFor(active, tool.serverName);
  const retained = active.retainViewAuthority(viewTools);
  const view = await fetchMcpAppView({
    uploadResources: await uploadFor(active, tool.serverName, retained.assertCurrent),
    ...extra
  });
  const lease = getMcpAppViewLease(view.viewId, active.runtime);
  if (lease) {
    lease.disposeCallbacks.add(retained.release);
  }
  return { result, view };
}
`.replace(/^ +/gm, spaces => '\t'.repeat(spaces.length / 2));

const hostFileFixture = `
async function withHostFile(options, view, uri, operation, mutation = false) {
  const file = view.hostFile;
  const sessionKey = view.runtime.sessionKey;
  if (!file || file.resourceUri !== uri || !sessionKey) throw new Error("wrong file");
  const read = retainSessionScopedRead(options, sessionKey, view.agentId, {
    requireMaterialized: true
  });
  const assertCurrent = () => {
    read.assertCurrent();
    if (mutation) view.authorizeAppInteraction();
  };
  try {
    await requireMcpAppInteraction(view);
    assertCurrent();
    const result = await operation(file, assertCurrent);
    if (!mutation) {
      await requireMcpAppInteraction(view);
      assertCurrent();
    }
    return result;
  } finally {
    read.release();
  }
}
async function readMcpAppHostFile(options, view, params) {
  return withHostFile(options, view, params.uri, async (file, assertCurrent) => {
    await options.beforeRead();
    assertCurrent();
    return file.resourceUri;
  });
}
async function writeMcpAppHostFile(options, view, params) {
  if (view.hostFile?.resourceUri !== params.uri) throw new Error("wrong file");
  await requireMcpAppInteraction(view);
  return withHostFile(options, view, params.uri, async (file, assertCurrent) => {
    await options.beforeCommit();
    assertCurrent();
    const result = await options.write(file, params);
    return result.status === "conflict" ? result.currentHash : result.hash;
  }, true);
}
`.replace(/^ +/gm, spaces => '\t'.repeat(spaces.length / 2));

const checkedTool = { toolName: 'safe', serverName: 'fixture', approval: true };
type ModelEntry = { model: string | { primary: string; fallbacks?: string[] } };
const config: {
  mcp: { apps: { enabled: boolean } };
  agents: {
    defaults: { model: { primary: string; fallbacks: string[] } };
    entries: Record<string, ModelEntry>;
  };
} = {
  mcp: { apps: { enabled: true } },
  agents: {
    defaults: { model: { primary: 'a', fallbacks: ['a'] } },
    entries: { primary: { model: 'a' } },
  },
};

type Entry = {
  sessionId: string;
  permissionMode: string;
  modelOverride?: string;
  authProfileOverride?: string;
  toolOverrides?: unknown;
};
type View = { toolApprovalGrants: Map<string, Set<string>> };
type Approval = { view?: View; assertCurrent: () => void };
type Request = {
  toolName: string;
  assertCurrent: () => void;
  options: { client: { id: string } };
  view?: View;
};
type Retained = {
  assertCurrent: () => void;
  assertStrictCurrent: () => void;
  captureSelection: () => () => void;
  prepareToolCall: (request: Request) => Promise<() => void>;
  release: () => void;
};

function buildBundle(source: string) {
  const body = source.replace(/^import .*agent-bundle.*;$/m, '');
  return transformSync(`const sessionMcpRuntimeOwners = resolveGlobalSingleton(Symbol.for("openclaw.sessionMcpRuntimeOwners"));
function peekSessionMcpRuntime() { return undefined; }\n${body}`, {
    format: 'esm',
  }).code;
}

async function setup(options: { pristine?: boolean; eligible?: boolean } = {}) {
  let entry: Entry = { sessionId: 'session', permissionMode: 'prompt' };
  let cfg = structuredClone(config);
  let accessCurrent = true;
  let allowModel = (_model: string) => true;
  const runtime = { workspaceDir: '/fixture', mcpAppModelContextRevoked: false };
  let liveOwner = runtime;
  const listeners: Array<(change: { kind: 'row'; agentId: string }) => void> = [];
  let promptCount = 0;
  const promptWaiters: Array<() => void> = [];
  let holdApproval = false;
  let released = 0;
  let ownerCurrent = true;
  const original = options.pristine ? fixture : transform(fixture);
  const body = original.replace(/^import .*?;$/gm, '');
  const manager = {
    async acquireSessionMcpRuntime() { return { runtime }; },
    peekSessionMcpRuntime() { return liveOwner; },
    sessionMcpRuntimeOwners: new Map([[runtime, { isCurrent: () => ownerCurrent }]]),
  };
  const getModel = (entry: Entry, cfg: typeof config) =>
    entry.modelOverride ?? cfg.agents.defaults.model.primary;
  const prepare = vm.runInNewContext(`${body}\nprepareMcpAppExtensionRuntime;`, {
    ...manager,
    mcpAppDeepEqual: isDeepStrictEqual,
    resolveSessionSelectedModelRef: (args: { entry: Entry; cfg: typeof cfg }) => ({
      provider: 'fixture', model: getModel(args.entry, args.cfg),
    }),
    resolveEffectiveAgentRuntime: ({ model }: { model: { model: string } }) =>
      model.model === 'external' ? 'external' : 'openclaw',
    resolveMcpAppRequesterId: (client: { id: string }) => client.id,
    requestMcpAppToolApproval: async ({ view, assertCurrent }: Approval) => {
      assertCurrent();
      const grant = view?.toolApprovalGrants.get('caller');
      if (grant?.has(checkedTool.toolName)) return;
      promptCount++;
      if (holdApproval) await new Promise<void>(resolve => promptWaiters.push(resolve));
      assertCurrent();
      if (view) view.toolApprovalGrants.set('caller', new Set([checkedTool.toolName]));
    },
  }) as (params: unknown) => Promise<{
    retainViewAuthority: (tools: typeof checkedTool[], allow?: boolean) => Retained;
  }>;
  const assertAccess = () => {
    if (!accessCurrent) throw new Error('native access revoked');
  };
  const active = await prepare({
    workspaceDir: '/fixture',
    projection: {
      sharingTarget: () => ({ entry }),
      onSelectionChange: (listener: typeof listeners[number]) => { listeners.push(listener); },
    },
    sessionAccessAuthority: {
      target: { agentId: 'agent', sessionKey: 'key', sessionId: 'session' },
      assertCurrent: assertAccess,
      retain: () => ({ assertCurrent: assertAccess, release: () => released++ }),
    },
    context: { getRuntimeConfig: () => cfg },
    isAllowed: (entry: Entry, current: typeof cfg) => allowModel(getModel(entry, current)),
  });
  const authority = active.retainViewAuthority([checkedTool], options.eligible ?? true);
  const request = (view?: View): Request => ({
    toolName: 'safe', options: { client: { id: 'caller' } }, assertCurrent: () => {}, view,
  });
  return {
    authority,
    request,
    patchEntry(fields: Partial<Entry>) {
      entry = { ...entry, ...fields };
      for (const listener of listeners) listener({ kind: 'row', agentId: 'agent' });
    },
    updateConfig(next: typeof config) { cfg = next; },
    replaceOwner() { liveOwner = { ...runtime }; },
    retireOwner() { ownerCurrent = false; },
    revokeAccess() { accessCurrent = false; },
    deny(model: string) { allowModel = current => current !== model; },
    holdApproval() { holdApproval = true; },
    resolveApproval() { promptWaiters.shift()?.(); holdApproval = false; },
    get prompts() { return promptCount; },
    get released() { return released; },
    observe: () => listeners.length,
  };
}

describe('native MCP App model continuity patch', () => {
  it('applies one exact locked source shape and verifies the emitted bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-model-continuity-'));
    try {
      const source = path.join(root, NATIVE);
      const hostFiles = path.join(root, FILES);
      const bundle = path.join(root, 'gateway-bundle.mjs');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, fixture);
      fs.writeFileSync(hostFiles, hostFileFixture);
      expect(() => patch.verifyPatch(root)).toThrow(/missing/);
      expect(patch.applyPatch(root)).toEqual([path.relative(root, source), path.relative(root, hostFiles)]);
      const patched = fs.readFileSync(source, 'utf8');
      expect(patched).toContain(CONTRACT);
      const emitted = buildBundle(patched + '\n' + fs.readFileSync(hostFiles, 'utf8'));
      const operation = functionRange(emitted, 'withHostFile').text;
      // The full Gateway bundle renames local bindings that this smaller fixture keeps.
      const renamed = operation.replace(/\bread\b/g, 'read7').replace(/(?<!\.)\bsessionKey\b/g, 'sessionKey3');
      fs.writeFileSync(bundle, emitted.replace(operation, renamed));
      expect(patch.applyPatch(root)).toEqual([]);
      expect(() => patch.verifyPatch(root)).not.toThrow();
      fs.writeFileSync(source, patched.replace(
        'requesterId: resolveMcpAppRequesterId(request.options.client),',
        'requesterId: undefined,',
      ));
      expect(() => patch.verifyPatch(root)).toThrow(/changed retained view authority/);
      fs.writeFileSync(source, patched);
      const out = fs.readFileSync(bundle, 'utf8').replace('generation !== capturedGeneration', 'false');
      fs.writeFileSync(bundle, out);
      expect(() => patch.applyPatch(root)).toThrow(/bundled retained view authority/);
      expect(fs.readFileSync(source, 'utf8')).toBe(patched);
    } finally {
      if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('mcp-model-continuity-'))
        fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps stock and excluded paths strict while following an eligible view', async () => {
    const stock = await setup({ pristine: true });
    const excluded = await setup({ eligible: false });
    const eligible = await setup();
    for (const state of [stock, excluded, eligible]) state.patchEntry({ modelOverride: 'b' });
    for (const state of [stock, excluded]) {
      expect(state.authority.assertCurrent).toThrow(/runtime selection changed/);
      await expect(state.authority.prepareToolCall(state.request())).rejects.toThrow(/runtime selection changed/);
    }
    expect(eligible.authority.assertCurrent).not.toThrow();
    expect(eligible.authority.assertStrictCurrent).toThrow(/runtime selection changed/);
    const commit = await eligible.authority.prepareToolCall(eligible.request());
    expect(commit).not.toThrow();
    eligible.deny('b');
    expect(commit).toThrow(/current policy/);
  });

  it('allows only primary model config changes for the exact retained owner and role', async () => {
    const state = await setup();
    const primaryOnly = structuredClone(config);
    primaryOnly.agents.defaults.model.primary = 'b';
    primaryOnly.agents.entries.primary.model = { primary: 'b' };
    state.updateConfig(primaryOnly);
    expect(state.authority.assertCurrent).not.toThrow();
    const unrelated = structuredClone(primaryOnly);
    unrelated.agents.defaults.model.fallbacks.push('c');
    state.updateConfig(unrelated);
    expect(state.authority.assertCurrent).toThrow(/configuration changed/);
    const roster = structuredClone(primaryOnly);
    roster.agents.entries.other = { model: 'b' };
    state.updateConfig(roster);
    expect(state.authority.assertCurrent).toThrow(/configuration changed/);
    state.updateConfig(primaryOnly);
    state.revokeAccess();
    expect(state.authority.assertCurrent).toThrow(/native access revoked/);
    const replaced = await setup();
    replaced.replaceOwner();
    expect(replaced.authority.assertCurrent).toThrow(/runtime selection changed/);
    const retiring = await setup();
    retiring.retireOwner();
    expect(retiring.authority.assertCurrent).toThrow(/runtime selection changed/);
    const external = await setup();
    external.patchEntry({ modelOverride: 'external' });
    expect(external.authority.assertCurrent).toThrow(/runtime selection changed/);
    const differentPolicy = await setup();
    differentPolicy.patchEntry({ toolOverrides: { disabled: true } });
    expect(differentPolicy.authority.assertCurrent).toThrow(/runtime selection changed/);
  });

  it('fences a held approval through model ABA and rotates only each view cache', async () => {
    const state = await setup();
    const first = { toolApprovalGrants: new Map<string, Set<string>>() };
    const second = { toolApprovalGrants: new Map<string, Set<string>>() };
    for (const view of [first, second, first]) await state.authority.prepareToolCall(state.request(view));
    expect(state.prompts).toBe(2);
    state.holdApproval();
    const pending = state.authority.prepareToolCall(state.request());
    state.patchEntry({ modelOverride: 'b' });
    state.patchEntry({ modelOverride: undefined });
    state.resolveApproval();
    await expect(pending).rejects.toThrow(/runtime selection changed/);
    for (const view of [first, second, first, second]) await state.authority.prepareToolCall(state.request(view));
    expect(state.prompts).toBe(5);
    state.authority.release();
    expect(state.released).toBe(1);
    expect(state.observe()).toBe(1);
  });

  it('allows later file operations but rejects writes across preflight and commit model switches', async () => {
    const state = await setup();
    const source = transform(hostFileFixture, FILES);
    const uri = 'openclaw-file://fixture';
    const file = { resourceUri: uri };
    const view = {
      hostFile: file,
      runtime: { sessionKey: 'key' },
      agentId: 'agent',
      authorizeAppInteraction: state.authority.assertCurrent,
      captureMcpAppFileSelection: state.authority.captureSelection,
    };
    let preflight: Promise<void> | undefined;
    let writes = 0;
    const write = vm.runInNewContext(`${source}\nwriteMcpAppHostFile;`, {
      requireMcpAppInteraction: async () => { await preflight; state.authority.assertCurrent(); },
      retainSessionScopedRead: () => ({ assertCurrent: () => {}, release: () => {} }),
    }) as (options: unknown, view: unknown, params: unknown) => Promise<number | string>;
    const save = () => ({ status: 'saved', hash: ++writes });
    const request = (beforeCommit = async () => {}, writeFile: () => unknown = save) => write({
      beforeCommit,
      write: writeFile,
    }, view, { uri });
    const waitingForPreflight = Promise.withResolvers<void>();
    preflight = waitingForPreflight.promise;
    const pendingAdmission = request();
    state.patchEntry({ modelOverride: 'b' });
    waitingForPreflight.resolve();
    await expect(pendingAdmission).rejects.toThrow(/runtime selection changed/);
    expect(writes).toBe(0);
    await expect(request()).resolves.toBe(1);
    const reachedCommit = Promise.withResolvers<void>();
    const resumeCommit = Promise.withResolvers<void>();
    const pendingCommit = request(async () => {
      reachedCommit.resolve();
      await resumeCommit.promise;
    });
    await reachedCommit.promise;
    state.patchEntry({ modelOverride: 'a' });
    state.patchEntry({ modelOverride: 'b' });
    resumeCommit.resolve();
    await expect(pendingCommit).rejects.toThrow(/runtime selection changed/);
    expect(writes).toBe(1);
    await expect(request()).resolves.toBe(2);
    await expect(request(undefined, () => {
      state.patchEntry({ modelOverride: 'a' });
      return { status: 'conflict', currentHash: 'other revision' };
    })).rejects.toThrow(/runtime selection changed/);
    await expect(request(undefined, () => {
      const saved = save();
      state.patchEntry({ modelOverride: 'b' });
      return saved;
    })).resolves.toBe(3);
  });

  it('checks current file read authority without capturing a write generation', async () => {
    const state = await setup();
    const source = transform(hostFileFixture, FILES);
    const uri = 'openclaw-file://fixture';
    const view = {
      hostFile: { resourceUri: uri },
      runtime: { sessionKey: 'key' },
      agentId: 'agent',
      captureMcpAppFileSelection: () => {
        throw new Error('a read requested write authority');
      },
    };
    const read = vm.runInNewContext(`${source}\nreadMcpAppHostFile;`, {
      requireMcpAppInteraction: async () => state.authority.assertCurrent(),
      retainSessionScopedRead: () => ({ assertCurrent: () => {}, release: () => {} }),
    }) as (options: unknown, view: unknown, params: unknown) => Promise<string>;
    await expect(read({
      beforeRead: () => state.patchEntry({ modelOverride: 'b' }),
    }, view, { uri })).resolves.toBe(uri);
    await expect(read({
      beforeRead: () => state.deny('b'),
    }, view, { uri })).rejects.toThrow(/current policy/);
  });
});
