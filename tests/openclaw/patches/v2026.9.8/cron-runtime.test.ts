import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';

import { describe, expect, it, test } from 'vitest';
const {
  __testing: { seams, transform },
} = require('../../../../scripts/patches/v2026.9.8/030-cron-session-permission.cjs');
const runtimeDir = path.resolve('vendor/openclaw-runtime/current/dist');
const runtimePackage = path.join(runtimeDir, '..', 'package.json');
const matchingRuntime =
  fs.existsSync(runtimePackage) &&
  JSON.parse(fs.readFileSync(runtimePackage, 'utf8')).version === '2026.9.8';
describe.skipIf(!matchingRuntime || !fs.existsSync(runtimeDir))(
  'installed native exec policy integration',
  { timeout: 120_000 },
  () => {
    it('native Full and read-only enforce filesystem and approval policy', async () => {
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        const root = process.argv[1];
        async function exported(prefix, name) {
          const file = fs.readdirSync(root).find(file => file.startsWith(prefix) && /\\.m?js$/.test(file));
          assert.ok(file, prefix);
          const loaded = await import(pathToFileURL(path.join(root, file)).href);
          const fn = Object.values(loaded).find(value => typeof value === 'function' && value.name === name);
          assert.equal(typeof fn, 'function', name);
          return fn;
        }
        function matches(actual, expected) {
          for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
        }
        const policy = await exported('session-permission-exec-mode-', 'resolveSessionPermissionCoreToolPolicy');
        matches(policy({ mode: 'full' }), { workspaceOnly: false, readOnly: false, applyPatchWorkspaceOnly: false, execMode: 'full', bypassHostApprovalFloors: true });
        const defaults = await exported('exec-defaults-', 'resolveExecDefaults');
        const base = {
          cfg: { agents: { entries: { main: {} } }, tools: { exec: { host: 'gateway', mode: 'ask' } } },
          agentId: 'main', sessionKey: 'agent:main:cron:test:run:test',
          execApprovals: { version: 1, defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' }, agents: {} }
        };
        matches(defaults({ ...base, sessionEntry: { permissionMode: 'full' } }), { mode: 'full', security: 'full', ask: 'off' });
        matches(defaults({ ...base, sessionEntry: { permissionMode: 'read-only' } }), { mode: 'deny', security: 'deny' });
      `;
      // Native Node loading avoids transforming the installed runtime through Vitest.
      await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', script, runtimeDir],
        {
          timeout: 110_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );
    });

    it('preserves native permissions across payload edits and kind changes', () => {
      const file = fs
        .readdirSync(runtimeDir)
        .find(name => name.startsWith('jobs-') && /\.m?js$/u.test(name))!;
      const seam = seams.find((entry: { name: string }) => entry.name === 'MERGE');
      const source = transform(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), seam);
      const functions = [
        'applyToolsAllowPatch',
        'toolsAllowEqual',
        'mergeCronPayload',
        'buildPayloadFromPatch',
      ]
        .map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0])
        .join('\n');
      const merge = vm.runInNewContext(`${functions}; mergeCronPayload`);
      const full = {
        kind: 'agentTurn',
        message: 'Report',
        toolsAllow: ['*'],
        permissionMode: 'full',
      };
      expect(merge(full, { kind: 'agentTurn', message: 'Renamed' })).toMatchObject({
        permissionMode: 'full',
      });
      expect(
        merge(full, { kind: 'agentTurn', permissionMode: 'read-only', toolsAllow: ['read'] }),
      ).toMatchObject({ permissionMode: 'read-only' });
      expect(merge({ kind: 'systemEvent', text: 'Wake' }, full)).toMatchObject(full);
      expect(merge(full, { kind: 'systemEvent', text: 'Wake' })).not.toHaveProperty(
        'permissionMode',
      );
    });
  },
);

test.skipIf(!matchingRuntime)(
  'verifies cron authorization after bundling renames handler and guard parameters',
  () => {
    const bundle = path.resolve('vendor/openclaw-runtime/current/gateway-bundle.mjs');
    if (!fs.existsSync(bundle)) return;
    const source = fs.readFileSync(bundle, 'utf8');
    const handler = seams.find((entry: { name: string }) => entry.name === 'HANDLERS');
    const patched = transform(source, handler);
    expect(transform(patched, handler)).toBe(patched);
    expect(() =>
      transform(
        patched.replace(
          /(function justDoCronPermissionGuard\([^]*?)operator\.admin/,
          '$1operator.write',
        ),
        handler,
      ),
    ).toThrow();
  },
  30_000,
);
