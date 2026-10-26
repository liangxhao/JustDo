import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/020-shared-terminal-launch.cjs');
const { transform } = patch.__testing;
const schemas = `const TerminalOpenParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString), sessionKey: Type.Optional(NonEmptyString),
  catalog: Type.Optional(SessionCatalogLocatorSchema), cols: TerminalDimension, rows: TerminalDimension
});
const TerminalCloseParamsSchema = closedObject({ sessionId: NonEmptyString });`;
const manager = `class TerminalSessionManager {
close(connId, sessionId) {
  const session = this.sessions.get(sessionId);
  if (!session) return false;
  if (session.owner?.kind === "agent") {
    if (!session.viewers.has(connId)) return false;
    if (session.unadoptedViewerConnId === connId) {
      this.finalize(session, "closed", {}); return true;
    }
    return this.removeViewer(session, connId);
  }
  if (session.owner?.kind !== "conn" || session.owner.connId !== connId || session.closed) return false;
  this.finalize(session, "closed", {}); return true;
}
}`;
const rpc = `async function openTerminalSession(opts, request) {
  const refreshedLaunch = opts.context.resolveTerminalLaunchPolicy(request.agentId);
  if (!refreshedLaunch.ok) throw new Error("sandboxed or disabled");
  const catalogPlan = request.catalogPlan;
  const spawnPlan = resolveTerminalOpenSpawnPlan(refreshedLaunch.plan, catalogPlan);
  const terminalEnv = {};
  return opts.context.terminalSessions.open({ ...spawnPlan, env: terminalEnv });
}
function terminalSessionHandler(_method, _validate, operate) { return opts => operate(opts.context.terminalSessions, opts.connId, opts.params); }
function validateTerminalCloseParams() {}
const terminalHandlers = {
  "terminal.open": async (opts) => {
    const { params } = opts;
    return openTerminalSession(opts, { agentId: params.agentId, sessionKey: params.sessionKey, cols: params.cols, rows: params.rows });
  },
  "terminal.close": terminalSessionHandler("terminal.close", validateTerminalCloseParams,
    (manager, connId, params) => manager.close(connId, params.sessionId))
};`;

describe('shared terminal build seam', () => {
  it('launches the requested project shell through the native RPC and leaves catalog launches intact', async () => {
    const context = {
      resolveTerminalOpenSpawnPlan: (plan: object, catalog?: object) => catalog ?? plan,
    };
    const handlers = vm.runInNewContext(`${transform(rpc)}; terminalHandlers;`, context);
    const open = vi.fn((request: object) => request);
    const params = {
      sessionKey: 'agent:main:chat',
      cwd: 'C:/项目 with spaces',
      shell: 'powershell.exe',
      args: ['-NoLogo'],
      cols: 80,
      rows: 24,
    };
    const launchPolicy = vi.fn(() => ({
      ok: true,
      plan: { cwd: 'role-home', shell: 'cmd.exe', args: [] },
    }));
    const opts = {
      params,
      context: { resolveTerminalLaunchPolicy: launchPolicy, terminalSessions: { open } },
    };
    const result = await handlers['terminal.open'](opts);
    expect(result).toMatchObject({ cwd: params.cwd, shell: params.shell, args: params.args });
    launchPolicy.mockReturnValueOnce({ ok: false, plan: {} });
    await expect(handlers['terminal.open'](opts)).rejects.toThrow('sandboxed or disabled');
    expect(open).toHaveBeenCalledTimes(1);
    const run = vm.runInNewContext(`${transform(rpc)}; openTerminalSession;`, { ...context });
    const catalog = { cwd: 'native-catalog-project', shell: 'native-cli', args: ['resume'] };
    expect(await run(opts, { ...params, catalogPlan: catalog })).toMatchObject(catalog);
  });

  it('terminates an adopted shared PTY only for an attached viewer and preserves ordinary detach', () => {
    for (const compiled of [false, true]) {
      const patched = transform(manager);
      const source = compiled
        ? transformSync(patched, { minifySyntax: true, legalComments: 'none' }).code
        : patched;
      const Klass = vm.runInNewContext(`${source}; TerminalSessionManager;`);
      const instance = new Klass();
      const session = {
        owner: { kind: 'agent' },
        viewers: new Set(['operator']),
        unadoptedViewerConnId: undefined,
      };
      instance.sessions = new Map([['pty', session]]);
      instance.finalize = vi.fn();
      instance.removeViewer = vi.fn(() => true);
      expect(instance.close('stranger', 'pty', true)).toBe(false);
      expect(instance.finalize).not.toHaveBeenCalled();
      expect(instance.close('operator', 'pty')).toBe(true);
      expect(instance.removeViewer).toHaveBeenCalledOnce();
      expect(instance.close('operator', 'pty', true)).toBe(true);
      expect(instance.finalize).toHaveBeenCalledWith(session, 'closed', {});
    }
  });

  it('is idempotent in source and compiled bundles and rejects historical or partial changes', () => {
    for (const fixture of [schemas, manager, rpc]) {
      const patched = transform(fixture, 'source.mjs');
      expect(transform(patched, 'source.mjs')).toBe(patched);
      const compiled = transformSync(patched, { minifySyntax: true, legalComments: 'none' }).code;
      expect(transform(compiled, 'gateway-bundle.mjs')).toBe(compiled);
      if (fixture === rpc) {
        const renamed = compiled.replaceAll('request', 'request5');
        expect(transform(renamed, 'gateway-bundle.mjs')).toBe(renamed);
      }
      expect(() => transform(patched.replaceAll('V2026_10_7', 'V2026_9_6'), 'source.mjs')).toThrow();
      expect(() =>
        transform(
          patched.replace(/\/\/ RUNTIME_SHARED_TERMINAL_LAUNCH_V2026_10_7\n/, ''),
          'source.mjs',
        ),
      ).toThrow();
    }
    expect(() =>
      transform(transform(manager).replace('session.viewers.has(connId)', 'true')),
    ).toThrow();
    expect(() => transform(transform(schemas).replace('maxItems: 32', 'maxItems: 64'))).toThrow();
  });

  it('plans every source edit before writing and refuses a partially applied capability', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-terminal-patch-'));
    try {
      const dist = path.join(root, 'dist');
      fs.mkdirSync(dist);
      const contents = [schemas, manager, rpc];
      contents.forEach((text, i) => fs.writeFileSync(path.join(dist, `${i}.mjs`), text));
      expect(() => patch.verifyPatch(root)).toThrow();
      expect(patch.applyPatch(root)).toHaveLength(3);
      patch.verifyPatch(root);
      expect(patch.applyPatch(root)).toEqual([]);
      fs.writeFileSync(path.join(dist, '1.mjs'), manager);
      const snapshot = fs.readFileSync(path.join(dist, '0.mjs'));
      expect(() => patch.applyPatch(root)).toThrow('Mixed pristine');
      expect(fs.readFileSync(path.join(dist, '0.mjs'))).toEqual(snapshot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects mixed native/bundle states and mixed bundle sub-capabilities without writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-terminal-mixed-'));
    const native = [schemas, manager, rpc];
    const files = ['dist/0.mjs', 'dist/1.mjs', 'dist/2.mjs', 'gateway-bundle.mjs'];
    try {
      fs.mkdirSync(path.join(root, 'dist'));
      for (const [nativeCurrent, bundleStates] of [[true, [false, false, false]], [false, [true, true, true]], [false, [false, true, false]], [true, [true, false, true]]] as const) {
        files.forEach((file, i) => {
          const source = i < 3 ? (nativeCurrent ? transform(native[i], file) : native[i]) : transformSync(native.map((value, j) => bundleStates[j] ? transform(value, file) : value).join('\n'), { legalComments: 'none' }).code;
          fs.writeFileSync(path.join(root, file), source);
        });
        const before = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
        expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
        expect(files.map(file => fs.readFileSync(path.join(root, file), 'utf8'))).toEqual(before);
      }
      files.forEach((file, i) => fs.writeFileSync(path.join(root, file), i < 3 ? native[i] : native.join('\n').replace('const TerminalCloseParamsSchema = closedObject({ sessionId: NonEmptyString });', '')));
      const missingClose = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
      expect(() => patch.applyPatch(root)).toThrow(/schema/);
      expect(files.map(file => fs.readFileSync(path.join(root, file), 'utf8'))).toEqual(missingClose);
      files.slice(0, 3).forEach((file, i) => fs.writeFileSync(path.join(root, file), transform(native[i], file)));
      fs.writeFileSync(path.join(root, files[3]), transformSync(native.map(value => transform(value, files[3])).join('\n'), { minifySyntax: true, legalComments: 'none' }).code);
      expect(patch.verifyPatch(root)).toEqual([]);
      expect(patch.applyPatch(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
