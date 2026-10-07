import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.9.8/036-shared-terminal-launch.cjs');
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
const terminalHandlers = {
  "terminal.open": async (opts) => {
    const { params } = opts;
    return openTerminalSession(opts, { agentId: params.agentId, sessionKey: params.sessionKey, cols: params.cols, rows: params.rows });
  },
  "terminal.close": async (opts) => {
    const { params, context } = opts;
    const connId = opts.connId;
    return context.terminalSessions?.close(connId, params.sessionId) ?? false;
  }
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
      expect(() => transform(patched.replaceAll('V2026_9_8', 'V2026_9_6'), 'source.mjs')).toThrow();
      expect(() =>
        transform(
          patched.replace(/\/\/ JUSTDO_SHARED_TERMINAL_LAUNCH_V2026_9_8\n/, ''),
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-terminal-patch-'));
    try {
      const dist = path.join(root, 'dist');
      fs.mkdirSync(dist);
      const contents = [schemas, manager, rpc, schemas + '\n' + manager + '\n' + rpc];
      contents.forEach((text, i) => fs.writeFileSync(path.join(dist, `${i}.mjs`), text));
      expect(() => patch.verifyPatch(root)).toThrow();
      expect(patch.applyPatch(root)).toHaveLength(4);
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
});
