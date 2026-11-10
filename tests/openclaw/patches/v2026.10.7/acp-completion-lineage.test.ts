import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/036-acp-completion-lineage.cjs');
const { transform, TARGET, CONTRACT } = patch.__testing;
const { functionRange, parse, collect, one } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const ts = require('typescript');

const fixture = `function resolveSpawnAdmission(params) {
  const requesterPolicyError = resolveSenderRestrictedSpawnError(params);
  if (requesterPolicyError) return { ok: false, error: requesterPolicyError };
  if (params.enabled === false) return { ok: true };
  const callerDepth = getSubagentDepthFromSessionStore(params.requesterSessionKey, { cfg: params.cfg });
  const maxSpawnDepth = params.cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 5;
  const childAdmission = resolveChildAdmission({ callerDepth, maxSpawnDepth });
  if (!childAdmission.ok) return childAdmission;
  const targetPolicy = resolveSubagentTargetPolicy(params);
  if (!targetPolicy.ok) return targetPolicy;
  const capabilities = resolveSubagentCapabilities({ depth: callerDepth + 1, maxSpawnDepth });
  return { ok: true, maxSpawnDepth, childSessionPatch: {
    spawnDepth: capabilities.depth,
    subagentRole: capabilities.role === 'main' ? null : capabilities.role,
    subagentControlScope: capabilities.controlScope,
  } };
}
export { resolveSpawnAdmission };`;
const fixtureRoot = path.resolve('build/patch-tests/acp-completion-lineage');
const roots: string[] = [];

function createRoot(source = fixture) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
  roots.push(root);
  fs.mkdirSync(path.dirname(path.join(root, TARGET)), { recursive: true });
  fs.writeFileSync(path.join(root, TARGET), source);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== fixtureRoot) throw new Error('Invalid ACP fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function admission(source: string, dependencies: Record<string, unknown>) {
  return vm.runInNewContext(`${functionRange(source, 'resolveSpawnAdmission').text}\nresolveSpawnAdmission;`, dependencies);
}

describe('ACP completion lineage patch contract', () => {
  it('applies and verifies source and compiled bundle without changing already current bytes', () => {
    const root = createRoot();
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(patch.applyPatch(root)).toEqual([path.normalize(TARGET)]);
    const current = fs.readFileSync(path.join(root, TARGET), 'utf8');
    expect(transform(current)).toBe(current);
    const compiled = buildSync({ stdin: { contents: current }, bundle: true, write: false,
      platform: 'node', target: 'node24', format: 'esm', minifySyntax: true,
      treeShaking: false, legalComments: 'none' }).outputFiles[0].text;
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), compiled);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    expect(patch.applyPatch(root)).toEqual([]);
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(current);
    expect(fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8')).toBe(compiled);
  });

  it('rejects forged, partial and changed native shapes', () => {
    const current = transform(fixture);
    expect(() => transform(`// ${CONTRACT}\n${fixture}`)).toThrow();
    expect(() => transform(current.replace('completionCapabilities.depth', '0'))).toThrow();
    expect(() => transform(fixture.replace('maxSpawnDepth ?? 5', 'maxSpawnDepth ?? 9'))).toThrow();
    expect(() => transform(current.replaceAll('V2026_10_7', 'V2026_9_8'))).toThrow();
  });

  it('rejects mixed source and bundle state before writing either copy', () => {
    const root = createRoot();
    const current = transform(fixture);
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), current);
    expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(fixture);
    expect(fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8')).toBe(current);
  });

  it('keeps disabled admission ahead of all depth, quota and target checks', () => {
    const depth = vi.fn(() => { throw new Error('Unexpected synchronous depth read'); });
    const quota = vi.fn(() => { throw new Error('Unexpected quota check'); });
    const target = vi.fn(() => { throw new Error('Unexpected target check'); });
    const capabilities = vi.fn(() => ({ depth: 1, role: 'orchestrator', controlScope: 'children' }));
    const run = admission(transform(fixture), {
      resolveSenderRestrictedSpawnError: () => undefined,
      getSubagentDepthFromSessionStore: depth,
      resolveChildAdmission: quota,
      resolveSubagentTargetPolicy: target,
      resolveSubagentCapabilities: capabilities,
    });

    expect(run({ cfg: {}, enabled: false })).toEqual({ ok: true, childSessionPatch: {
      spawnDepth: 1, subagentRole: 'orchestrator', subagentControlScope: 'children',
    } });
    expect(capabilities).toHaveBeenCalledExactlyOnceWith({ depth: 1, maxSpawnDepth: 5 });
    expect(depth).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
  });

  it('preserves sender rejection and enabled admission outcomes', () => {
    const dependencies = {
      resolveSenderRestrictedSpawnError: (params: any) => params.senderError,
      getSubagentDepthFromSessionStore: () => 1,
      resolveChildAdmission: () => ({ ok: true }),
      resolveSubagentTargetPolicy: () => ({ ok: true }),
      resolveSubagentCapabilities: ({ depth }: any) => ({ depth, role: 'leaf', controlScope: 'none' }),
    };
    const before = admission(fixture, dependencies);
    const after = admission(transform(fixture), dependencies);
    expect(after({ cfg: {}, enabled: false, senderError: 'Sender cannot delegate' }))
      .toEqual({ ok: false, error: 'Sender cannot delegate' });
    expect(after({ cfg: {}, enabled: true })).toEqual(before({ cfg: {}, enabled: true }));
    expect(after({ cfg: {}, enabled: true })).toMatchObject({ ok: true, maxSpawnDepth: 5,
      childSessionPatch: { spawnDepth: 2, subagentRole: 'leaf', subagentControlScope: 'none' } });
    dependencies.resolveChildAdmission = () => ({ ok: false, error: 'Quota reached' } as any);
    expect(after({ cfg: {}, enabled: true })).toEqual(before({ cfg: {}, enabled: true }));
    expect(after({ cfg: {}, enabled: true })).toEqual({ ok: false, error: 'Quota reached' });
  });
});

// Optional default discovery never downloads a runtime. An explicit profile must run or fail.
const pristineDirectory = process.env.ACP_COMPLETION_LINEAGE_PRISTINE_DIR;
const archive = path.resolve('cache/openclaw/openclaw-2026.10.7.tgz');
const requireNative = process.env.ACP_COMPLETION_LINEAGE_REQUIRE_NATIVE === '1';
const nativeAvailable = Boolean(pristineDirectory || requireNative || fs.existsSync(archive));
const nativeSources = new Map<string, string>();
let archiveVerified = false;

function nativeSource(file: string): string {
  if (nativeSources.has(file)) return nativeSources.get(file)!;
  let source: string;
  if (pristineDirectory) {
    const metadata = JSON.parse(fs.readFileSync(path.join(pristineDirectory, 'package.json'), 'utf8'));
    if (metadata.version !== '2026.10.7') throw new Error('ACP completion proof requires locked openclaw@2026.10.7');
    source = fs.readFileSync(path.join(pristineDirectory, file), 'utf8');
  } else {
    if (!fs.existsSync(archive)) throw new Error('Required ACP completion native archive is unavailable');
    if (!archiveVerified) {
      const lock = require('../../../../scripts/patches/v2026.10.7/source-lock.json');
      expect(createHash('sha256').update(fs.readFileSync(archive)).digest('hex')).toBe(lock.tarballSha256);
      archiveVerified = true;
    }
    source = execFileSync('tar', ['-xOf', archive, `package/${file}`], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  }
  nativeSources.set(file, source);
  return source;
}

function nativeHarness(patched: boolean, maxSpawnDepth?: number) {
  const capsSource = nativeSource('dist/subagent-capabilities-Cl7C_fBg.mjs');
  const requesterSource = nativeSource('dist/requester-tool-policy-CFB6EqPI.mjs');
  const historySource = nativeSource('dist/session-history-4mIfZYvg.mjs');
  const provenanceSource = nativeSource('dist/input-provenance-B5YZS2Do.mjs');
  const limitsSource = nativeSource('dist/agent-limits-CB2bq0ey.mjs');
  const parentKey = 'agent:main:chat:source';
  const childKey = 'agent:main:acp:child';
  const rows: Record<string, any> = { [parentKey]: { sessionId: 'parent-native' } };
  const normalizeString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const scope: Record<string, any> = {
    normalizeOptionalString: normalizeString,
    normalizeOptionalLowercaseString: (value: unknown) => normalizeString(value)?.toLowerCase(),
    normalizeToolPolicyName: (value: string) => value.trim().toLowerCase(),
    uniqueStrings: (values: string[]) => [...new Set(values)],
    resolveNonNegativeIntegerOption: (value: number, fallback: number) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback,
    resolveIntegerOption: (value: number, fallback: number, options: { min: number }) => Number.isFinite(value) && value >= options.min ? Math.floor(value) : fallback,
    isStringOption: (value: unknown, values: unknown[]) => values.includes(value),
    INPUT_PROVENANCE_KIND_VALUES: ['external_user', 'inter_session', 'internal_system'],
    isAcpSessionKey: (value: string) => value.includes(':acp:'),
    isSubagentSessionKey: (value: string) => value.includes(':subagent:'),
    parseAgentSessionKey: (value: string) => {
      const parts = value.split(':');
      return parts[0] === 'agent' ? { agentId: parts[1], rest: parts.slice(2).join(':') } : undefined;
    },
    resolveSenderRestrictedSpawnError: () => undefined,
    getSubagentDepthFromSessionStore: () => { throw new Error('Root ACP must not read depth synchronously'); },
    resolveSessionStorePathCore: () => 'fixture',
    createSubagentSessionStore: () => rows,
    messageToolOwnsVisibleReply: () => false,
  };
  const context = vm.createContext(scope);
  const load = (source: string, names: string[]) => vm.runInContext(names.map(name => functionRange(source, name).text).join('\n'), context);
  load(limitsSource, ['isSubagentSpawnDepthAllowed']);
  load(capsSource, ['normalizeInheritedToolDenylist', 'inheritedToolDenyPatch', 'normalizeInheritedToolAllowlist',
    'inheritedToolAllowPatch', 'isSessionCapabilityLookup', 'asSessionCapabilityLookup', 'normalizeSubagentRole',
    'normalizeSubagentControlScope', 'shouldInspectStoredSubagentEnvelope', 'isDashboardSessionKey',
    'isSameAgentSessionStore', 'resolveSessionCapabilityEntry', 'resolveSubagentCapabilityStore',
    'resolveSubagentCapabilities', 'isStoredSubagentEnvelopeSession', 'isSubagentEnvelopeSession',
    'resolvePersistedSubagentToolPolicyEnvelope', 'resolveStoredSubagentToolPolicy']);
  load(provenanceSource, ['normalizeInputProvenance']);
  load(requesterSource, ['resolveExactSubagentCompletionEvent', 'isTrustedSubagentCompletionHandoffForRun',
    'resolveRequesterStoreKey', 'policyFromEnvelope', 'resolveDelegatedPolicy', 'hasVerifiedRequesterCompletionHandoff']);
  load(historySource, ['isClaudeCliProvider', 'resolveCompletionToolPolicy']);
  const original = nativeSource(TARGET);
  load(patched ? transform(original) : original, ['resolveSpawnAdmission']);
  const cfg = maxSpawnDepth === undefined ? {} : { agents: { defaults: { subagents: { maxSpawnDepth } } } };

  // Execute actual ACP admission and creation expressions; the database commit is the boundary.
  const producer = parse(nativeSource('dist/acp-spawn-CHXTOHux.mjs'));
  const initializer = (name: string) => one(collect(producer, (node: any) => ts.isVariableDeclaration(node) &&
    node.name.getText(producer) === name), `ACP ${name}`).initializer.getText(producer);
  const write = one(collect(producer, (node: any) => ts.isCallExpression(node) &&
    node.expression.getText(producer) === 'upsertSessionEntryCore'), 'ACP initial entry write');
  Object.assign(scope, {
    creationStamp: { sessionId: 'child-native', updatedAt: 1 }, requesterInternalKey: parentKey,
    ownership: { completionRequesterSessionKey: parentKey }, ctx: {}, senderRestricted: false,
    params: { runtime: 'acp', agentId: 'codeagent', mode: 'run', task: 'ACP completion proof', label: 'ACP completion proof' },
    parentLineage: { receipt: {} }, cfg, subagentStore: rows, requesterAgentId: 'main', targetAgentId: 'codeagent',
    resolveConfiguredAcpSubagentTargetIds: () => [],
  });
  const admissionResult = vm.runInContext(`(() => {
    const hasSubagentEnvelope = ${initializer('hasSubagentEnvelope')};
    const resolveAdmission = ${initializer('resolveAdmission')};
    return { admission: ${initializer('admission')}, hasSubagentEnvelope }; })()`, context);
  scope.admission = admissionResult.admission;
  rows[childKey] = vm.runInContext(`(() => { const childSessionPatch = ${initializer('childSessionPatch')};
    return (${write.arguments[1].getText(producer)}); })()`, context);
  const facts = {
    config: cfg, sessionKey: parentKey, sessionId: 'parent-native', modelProvider: 'provider', modelId: 'model',
    inputProvenance: { kind: 'inter_session', sourceTool: 'subagent_announce', sourceSessionKey: childKey },
    trustedInternalHandoff: { kind: 'subagent-completion', sourceSessionKey: childKey, sourceSessionId: 'child-native',
      targetSessionKey: parentKey, targetSessionId: 'parent-native', provider: 'provider', model: 'model' },
    preparedSessionCapabilityStore: rows,
  };
  const result = (overrides: Record<string, any> = {}) => {
    const current = { ...facts, ...overrides };
    const exact = scope.isTrustedSubagentCompletionHandoffForRun({ handoff: current.trustedInternalHandoff,
      inputProvenance: current.inputProvenance, sessionKey: current.sessionKey, sessionId: current.sessionId,
      provider: current.modelProvider, model: current.modelId,
      internalEvents: [{ type: 'task_completion', source: 'subagent', childSessionKey: childKey, childSessionId: 'child-native' }],
    });
    const proven = exact && scope.hasVerifiedRequesterCompletionHandoff(current);
    return scope.resolveCompletionToolPolicy({ run: { sessionEntry: rows[parentKey], opts: current },
      trustedSubagentAnnounceHandoff: proven, isSubagentAnnounceHandoff: true,
      isRawModelRun: false, isCliExecutionProvider: false, cliExecutionProvider: 'provider',
      completionNeedsMessageDelivery: false });
  };
  return { row: rows[childKey], rows, childKey, facts, result, rootHasSubagentEnvelope: admissionResult.hasSubagentEnvelope,
    envelope: () => scope.resolvePersistedSubagentToolPolicyEnvelope(childKey, { cfg, store: rows }) };
}

describe.skipIf(!nativeAvailable)('locked native ACP creation through completion proof', () => {
  it('reproduces the pristine lost tool surface and restores it through the actual producer stamp', () => {
    const before = nativeHarness(false);
    expect(before.rootHasSubagentEnvelope).toBe(false);
    expect(before.row.inheritedToolPolicyVersion).toBe(1);
    expect(before.row.spawnDepth).toBeUndefined();
    expect(before.envelope()).toBeUndefined();
    expect(before.result()).toMatchObject({ completionRetainsRequesterTools: false, disableTools: true });

    const after = nativeHarness(true);
    expect(after.row).toMatchObject({ spawnDepth: 1, subagentRole: 'orchestrator', subagentControlScope: 'children' });
    expect(after.envelope()).toMatchObject({ inheritedToolAllow: [], inheritedToolDeny: [] });
    expect(after.result()).toMatchObject({ completionRetainsRequesterTools: true, disableTools: false });
  });

  it('uses native leaf scope at the configured depth boundary', () => {
    const h = nativeHarness(true, 1);
    expect(h.row).toMatchObject({ spawnDepth: 1, subagentRole: 'leaf', subagentControlScope: 'none' });
    expect(h.result().disableTools).toBe(false);
  });

  it('retains requester tool caps and refuses missing or mismatched native proof', () => {
    const h = nativeHarness(true);
    const toolsAllow = ['read', 'exec'];
    expect(h.result({ toolsAllow }).runtimeToolsAllow).toBe(toolsAllow);
    expect(h.result({ toolsAllow: [] }).runtimeToolsAllow).toEqual([]);
    for (const overrides of [{ trustedInternalHandoff: undefined }, { sessionId: 'replacement' }, { modelId: 'different-model' }])
      expect(h.result(overrides).disableTools).toBe(true);
    h.row.inheritedToolPolicyVersion = undefined;
    expect(h.result().disableTools).toBe(true);
  });
});
