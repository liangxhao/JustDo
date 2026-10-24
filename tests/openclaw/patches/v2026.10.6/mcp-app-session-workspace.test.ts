import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';

const patch = require('../../../../scripts/patches/v2026.10.6/030-mcp-app-session-workspace.cjs');
const {
  functionRange,
} = require('../../../../scripts/patches/v2026.10.6/prepared-read-patch-shapes.js');
const { NATIVE, HELPER, CONTRACT } = patch.__testing;
const helper = `function resolveIngressWorkspaceOverrideForSessionRun(metadata) {
  const normalized = normalizeSpawnedRunMetadata(metadata);
  if (normalized.spawnedBy && normalized.workspaceDir) return normalized.workspaceDir;
  return normalizeOptionalString(metadata?.cwd);
}`;
const source = `function runtimeSelection(entry, model, harnessId) {
 return JSON.stringify([resolveSessionPinnedHarnessId(entry),model.provider,model.model,harnessId,
 entry.agentRuntimeOverride,entry.modelSelectionLocked,entry.providerOverride,entry.modelOverride,
 entry.authProfileOverride,entry.authProfileOverrideSource,entry.sandboxMode]);
}
async function prepareMcpAppExtensionRuntime(options) {
 const target = options.target, cfg = options.cfg, agentId = options.agentId;
 const selected = runtimeSelection(target.entry, {}, 'openclaw');
 const workspaceDir = target.entry.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);
 const current = () => {
   if (runtimeSelection(target.entry, {}, 'openclaw') !== selected) throw Error('owner changed');
 };
 await options.beforeAcquire?.(); current();
 return { workspaceDir, current };
}`;
const roots: string[] = [];
function fixture(bundle = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workspace-contract-'));
  roots.push(root);
  fs.mkdirSync(path.dirname(path.join(root, NATIVE)), { recursive: true });
  fs.writeFileSync(path.join(root, NATIVE), source);
  if (bundle) fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), helper + '\n' + source);
  return root;
}
function files(root: string) {
  return [NATIVE, 'gateway-bundle.mjs'].map(name => path.join(root, name)).filter(fs.existsSync);
}
function expectNoWrites(root: string) {
  const before = files(root).map(file => fs.readFileSync(file, 'utf8'));
  for (const method of ['applyPatch', 'verifyPatch']) {
    expect(() => patch[method](root)).toThrow();
    expect(files(root).map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('mcp-workspace-contract-')
    )
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('manual MCP App session workspace', () => {
  it.each([false, true])(
    'applies and verifies exact source/bundle state idempotently: bundle=%s',
    bundle => {
      const root = fixture(bundle);
      expect(() => patch.verifyPatch(root)).toThrow();
      expect(patch.applyPatch(root)).toHaveLength(bundle ? 2 : 1);
      expect(patch.applyPatch(root)).toEqual([]);
      expect(() => patch.verifyPatch(root)).not.toThrow();
      if (bundle) {
        const file = path.join(root, 'gateway-bundle.mjs');
        fs.writeFileSync(
          file,
          transformSync(fs.readFileSync(file, 'utf8'), { minifySyntax: true }).code,
        );
        expect(() => patch.verifyPatch(root)).not.toThrow();
      }
    },
  );

  it.each(['source', 'bundle'])('rejects %s-only current state without writes', group => {
    const root = fixture(true);
    const original = new Map(files(root).map(file => [file, fs.readFileSync(file)]));
    patch.applyPatch(root);
    for (const file of files(root))
      if ((group === 'source') === (path.basename(file) === 'gateway-bundle.mjs'))
        fs.writeFileSync(file, original.get(file)!);
    expectNoWrites(root);
  });

  it.each(['workspace', 'fingerprint', 'import', 'marker', 'historical', 'helper'])(
    'rejects partial/invalid %s without changing another target',
    change => {
      const root = fixture(true);
      patch.applyPatch(root);
      const file = path.join(root, change === 'helper' ? 'gateway-bundle.mjs' : NATIVE);
      let content = fs.readFileSync(file, 'utf8');
      if (change === 'workspace')
        content = content.replace('cwd: target.entry.spawnedCwd', 'cwd: undefined');
      if (change === 'fingerprint') content = content.replace(',entry.spawnedCwd', '');
      if (change === 'import') content = content.replace('r as ' + HELPER, 'r as otherHelper');
      if (change === 'marker') content = content.replace(CONTRACT, 'removed');
      if (change === 'historical') content += '\n// RUNTIME_MCP_APP_SESSION_WORKSPACE_V2026_9_8';
      if (change === 'helper')
        content = content.replace('return normalized.workspaceDir', 'return undefined');
      fs.writeFileSync(file, content);
      expectNoWrites(root);
    },
  );

  it.each(['missing', 'extra', 'renamed'])('rejects %s native owners', change => {
    const root = fixture();
    const file = path.join(root, NATIVE);
    if (change === 'missing') fs.unlinkSync(file);
    if (change === 'extra') fs.copyFileSync(file, path.join(root, 'dist/extra.mjs'));
    if (change === 'renamed') fs.renameSync(file, path.join(root, 'dist/renamed.mjs'));
    expect(() => patch.applyPatch(root)).toThrow();
  });

  it('uses native ingress precedence and revokes an in-flight preparation when persisted workspace facts change', async () => {
    const native = patch.__testing.transform(source, NATIVE);
    const context = vm.createContext({
      resolveAgentWorkspaceDir: () => '/role-home',
      resolveSessionPinnedHarnessId: () => 'openclaw',
      normalizeOptionalString: (value: unknown) =>
        typeof value === 'string' ? value.trim() || undefined : undefined,
      normalizeSpawnedRunMetadata: (value: Record<string, unknown>) => value,
    });
    vm.runInContext(
      helper +
        '\n' +
        functionRange(native, 'runtimeSelection').text +
        '\nasync ' +
        functionRange(native, 'prepareMcpAppExtensionRuntime').text,
      context,
    );
    const prepare = context.prepareMcpAppExtensionRuntime;
    for (const [entry, expected] of [
      [{ spawnedCwd: '/project' }, '/project'],
      [{ spawnedBy: 'parent', spawnedWorkspaceDir: '/child', spawnedCwd: '/project' }, '/child'],
      [{ spawnedWorkspaceDir: '/unused', spawnedCwd: '/project' }, '/project'],
      [{}, '/role-home'],
    ]) {
      expect((await prepare({ target: { entry }, cfg: {}, agentId: 'main' })).workspaceDir).toBe(
        expected,
      );
    }
    for (const field of ['spawnedBy', 'spawnedWorkspaceDir', 'spawnedCwd']) {
      const entry: Record<string, unknown> = { spawnedCwd: '/project' };
      await expect(
        prepare({
          target: { entry },
          cfg: {},
          agentId: 'main',
          beforeAcquire: () => {
            entry[field] = '/changed';
          },
        }),
      ).rejects.toThrow('owner changed');
    }
  });
});
