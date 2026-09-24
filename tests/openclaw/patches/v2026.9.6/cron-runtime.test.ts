import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { describe, it, test, expect } from 'vitest';
const {
  __testing: { seams, transform },
} = require('../../../../scripts/patches/v2026.9.6/030-cron-session-permission.cjs');
const runtimeDir = path.resolve('vendor/openclaw-runtime/current/dist');
describe.skipIf(!fs.existsSync(runtimeDir))(
  'installed native exec policy integration',
  { timeout: 30_000 },
  () => {
    it('Full permits file changes outside the workspace and bypasses host approval floors', async () => {
      const file = fs
        .readdirSync(runtimeDir)
        .find(name => name.startsWith('session-permission-exec-mode-') && /\.m?js$/u.test(name))!;
      const runtime = await import(
        /* @vite-ignore */ pathToFileURL(path.join(runtimeDir, file)).href
      );
      const resolve = Object.values(runtime).find(
        value =>
          typeof value === 'function' && value.name === 'resolveSessionPermissionCoreToolPolicy',
      ) as (input: unknown) => unknown;
      expect(resolve({ mode: 'full' })).toMatchObject({
        workspaceOnly: false,
        readOnly: false,
        applyPatchWorkspaceOnly: false,
        execMode: 'full',
        bypassHostApprovalFloors: true,
      });
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

    it('Full disables approvals while read-only denies exec despite a global Ask floor', async () => {
      const file = fs
        .readdirSync(runtimeDir)
        .find(name => name.startsWith('exec-defaults-') && /\.m?js$/u.test(name))!;
      const runtime = await import(
        /* @vite-ignore */ pathToFileURL(path.join(runtimeDir, file)).href
      );
      const resolve = Object.values(runtime).find(
        value => typeof value === 'function' && value.name === 'resolveExecDefaults',
      ) as (input: unknown) => unknown;
      const base = {
        cfg: {
          agents: { entries: { main: {} } },
          tools: { exec: { host: 'gateway', mode: 'ask' } },
        },
        agentId: 'main',
        sessionKey: 'agent:main:cron:test:run:test',
        execApprovals: {
          version: 1,
          defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
          agents: {},
        },
      };
      expect(resolve({ ...base, sessionEntry: { permissionMode: 'full' } })).toMatchObject({
        mode: 'full',
        security: 'full',
        ask: 'off',
      });
      expect(resolve({ ...base, sessionEntry: { permissionMode: 'read-only' } })).toMatchObject({
        mode: 'deny',
        security: 'deny',
      });
    });
  },
);

test('verifies cron authorization after bundling renames handler and guard parameters', () => {
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
}, 30_000);
