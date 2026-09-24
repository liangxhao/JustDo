import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { transformSync } from 'esbuild';

const patch = require('../../../../scripts/patches/v2026.9.2/030-cron-session-permission.cjs');
const { guard, prepare, execute, transform, seams } = patch.__testing;
const authorize = vm.runInNewContext(`(${guard})`);
const admin = { connect: { scopes: ['operator.admin'] } };
const job = (mode: string) => ({ sessionTarget: 'isolated', payload: { kind: 'agentTurn', permissionMode: mode } });
const handlerFixture = `const handlers = {
  "cron.add": async ({ client, context, respond, params }) => {
    const normalized = params;
    const candidate = normalized;
    const jobCreate = applyCronCreateCallerScopeDefault(candidate);
    return context.cron.add(jobCreate, {
      matchesExisting: (job) => cronJobMatchesDeclarationScope({ job, input: jobCreate }),
    });
  },
  "cron.update": async ({ client, context, respond, params }) => {
    const jobId = params.id;
    const normalizedPatch = params.patch;
    const patch = normalizedPatch;
    const currentJob = await context.cron.readJob(jobId);
    const jobToUpdate = currentJob;
    const nextJob = await assertValidCronUpdatePatch({ currentJob: jobToUpdate, patch, });
    return nextJob;
  },
  "cron.run": async ({ client, context, respond, params }) => {
    const jobId = params.id;
    const job = await context.cron.readJob(jobId);
    const commitGuard = resolveCronMutationCommitGuard(client, context, { jobId });
    return context.cron.enqueueRun(jobId, "force", { commitGuard });
  },
};`;

describe('native scheduled session permission', () => {
  it('rejects a Full upgrade between the RPC read and queue admission', async () => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'HANDLERS');
    const handlers = vm.runInNewContext(`${transform(handlerFixture, seam)}; handlers`, {
      readCronCallerScope: () => undefined,
      resolveCronMutationCommitGuard: () => undefined,
    });
    await expect(handlers['cron.run']({
      client: { connect: { scopes: ['operator.write'] } }, params: { id: 'task' }, respond: vi.fn(),
      context: { cron: {
        readJob: async () => job('read-only'),
        getJob: () => job('full'),
        enqueueRun: async (_id: string, _mode: string, options: { commitGuard: () => void }) => options.commitGuard(),
      } },
    })).rejects.toThrow(/operator.admin/);
  });

  it.each([undefined, { agentId: 'main' }])('rechecks Full authority when a queued manual run acquires its lock (scope %j)', async scope => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'HANDLERS');
    let current = job('read-only');
    let queuedGuard: (() => void) | undefined;
    const nativeGuard = vi.fn();
    const handlers = vm.runInNewContext(`${transform(handlerFixture, seam)}; handlers`, {
      readCronCallerScope: () => scope,
      resolveCronMutationCommitGuard: () => scope ? nativeGuard : undefined,
    });
    await handlers['cron.run']({
      client: { connect: { scopes: ['operator.write'] } }, params: { id: 'task' }, respond: vi.fn(),
      context: { cron: {
        readJob: async () => current,
        getJob: () => current,
        enqueueRun: async (_id: string, _mode: string, options: { commitGuard: () => void }) => {
          options.commitGuard();
          queuedGuard = options.commitGuard;
        },
      } },
    });
    expect(queuedGuard).toBeTypeOf('function');
    current = job('full');
    expect(() => queuedGuard!()).toThrow(/operator.admin/);
    if (scope) expect(nativeGuard).toHaveBeenCalledTimes(2);
  });

  it('guards declarative upserts against editing Full jobs and incompatible retained session targets', async () => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'HANDLERS');
    const handlers = vm.runInNewContext(`${transform(handlerFixture, seam)}; handlers`, {
      readCronCallerScope: () => undefined,
      applyCronCreateCallerScopeDefault: (value: unknown) => value,
      cronJobMatchesDeclarationScope: () => true,
    });
    const upsert = (client: unknown, input: unknown, existing: unknown) => handlers['cron.add']({
      client, params: input, respond: vi.fn(), context: { cron: {
        add: async (_input: unknown, options: { matchesExisting: (value: unknown) => boolean }) => options.matchesExisting(existing),
      } },
    });
    const legacy = { sessionTarget: 'isolated', payload: { kind: 'agentTurn', message: 'Replacement' } };
    await expect(upsert({ connect: { scopes: ['operator.write'] } }, legacy, job('full'))).rejects.toThrow(/operator.admin/);
    await expect(upsert(admin, job('full'), { ...legacy, sessionTarget: 'main' })).rejects.toThrow(/isolated/);
    await expect(upsert(admin, job('full'), legacy)).resolves.toBe(true);
  });

  it('verifies locked RPC guards after fresh gateway bundling', () => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'HANDLERS');
    const compiled = transformSync(transform(handlerFixture, seam), { target: 'node24' }).code;
    const reapplied = transform(compiled, seam);
    expect(transform(reapplied, seam)).toBe(reapplied);
    expect(() => transform(reapplied.replace('context.cron.getJob(jobId)', 'context.cron.getJob("other")'), seam)).toThrow(/partial/);
  });

  it('rejects historical and unknown capability markers', () => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'PREPARE');
    const result = transform('const cronSession = resolveCronSession({\n forceNew: true\n});', seam);
    expect(() => transform(result.replace('JUSTDO_CRON_SESSION_PERMISSION_V2026_9_2_PREPARE', 'JUSTDO_CRON_SESSION_PERMISSION_OLD_PREPARE'), seam)).toThrow(/historical/);
    expect(() => transform(result.replace('JUSTDO_CRON_SESSION_PERMISSION_V2026_9_2_PREPARE', 'JUSTDO_CRON_SESSION_PERMISSION_V2026_9_2_UNKNOWN'), seam)).toThrow(/unknown/);
  });
  it.each(['full', 'read-only'])('allows an explicit %s mode only from an unscoped admin', mode => {
    expect(authorize(job(mode), admin, undefined, vi.fn(), true)).toBe(true);
    for (const [client, scope] of [[undefined, undefined], [{ connect: { scopes: ['operator.write'] } }, undefined], [admin, { agentId: 'main' }]]) {
      const respond = vi.fn();
      expect(authorize(job(mode), client, scope, respond, true)).toBe(false);
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
  });

  it('protects existing Full tasks against scoped edits and manual runs', () => {
    expect(authorize(job('full'), admin, { agentId: 'main' }, vi.fn())).toBe(false);
    expect(authorize(job('read-only'), admin, { agentId: 'main' }, vi.fn())).toBe(true);
    expect(authorize({ ...job('full'), sessionTarget: 'main' }, admin, undefined, vi.fn(), true)).toBe(false);
  });

  it.each(['full', 'read-only'])('sets %s on every fresh run and forwards it to embedded tools', mode => {
    const preparation = prepare('const cronSession = resolveCronSession({\n forceNew: true\n});');
    const execution = execute('const options = { toolsAllow: params.agentPayload?.toolsAllow, scheduledRuntimeAuthority: params.job.runtimeAuthority, };');
    for (let run = 0; run < 2; run += 1) {
      const context: Record<string, unknown> = {
        input: { job: job(mode) }, workspaceDir: '/workspace',
        resolveCronSession: () => ({ sessionEntry: { sessionId: String(run) } }),
      };
      vm.runInNewContext(`${preparation}; globalThis.result = cronSession;`, context);
      expect(context.result).toMatchObject({ sessionEntry: { permissionMode: mode, sessionRoot: '/workspace' } });
      const dispatch: Record<string, unknown> = { params: { cronSession: context.result, job: job(mode) } };
      vm.runInNewContext(`${execution}; globalThis.result = options;`, dispatch);
      expect(dispatch.result).toMatchObject({ permissionMode: mode, sessionRoot: '/workspace' });
    }
  });

  it('does not promote legacy wildcard jobs or main-session tasks', () => {
    const code = prepare('const cronSession = resolveCronSession({\n forceNew: true\n});');
    const context: Record<string, unknown> = {
      input: { job: { sessionTarget: 'isolated', payload: { kind: 'agentTurn', toolsAllow: ['*'] } } },
      workspaceDir: '/workspace', resolveCronSession: () => ({ sessionEntry: {} }),
    };
    vm.runInNewContext(`${code}; globalThis.result = cronSession;`, context);
    expect(context.result).toEqual({ sessionEntry: {} });
    expect(() => vm.runInNewContext(code, { ...context, input: { job: { ...job('full'), sessionTarget: 'main' } } })).toThrow();
  });

  it('accepts only the exact current patch on reapplication', () => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'PREPARE');
    const result = transform('const cronSession = resolveCronSession({\n forceNew: true\n});', seam);
    expect(transform(result, seam)).toBe(result);
    expect(() => transform(result.replace('sessionRoot = workspaceDir', 'sessionRoot = "/other"'), seam)).toThrow(/partial/);
  });

  it('recognizes the current payload patch after gateway bundling rewrites spreads', () => {
    const seam = seams.find((entry: { name: string }) => entry.name === 'MERGE');
    const original = `function mergeCronPayload(existing, patch) {
      const next = { ...existing };
      if (typeof patch.message === "string") next.message = patch.message;
      return next;
}
function buildPayloadFromPatch(patch) {
      return { message: patch.message, timeoutSeconds: patch.timeoutSeconds };
}`;
    const compiled = transformSync(transform(original, seam), { target: 'node24' }).code;
    const reapplied = transform(compiled, seam);
    expect(transform(reapplied, seam)).toBe(reapplied);
    expect(() => transform(reapplied.replace('next.permissionMode = patch.permissionMode', 'next.permissionMode = "full"'), seam)).toThrow(/partial/);
  });
});

const runtimeDir = path.resolve('vendor/openclaw-runtime/current/dist');
describe.skipIf(!fs.existsSync(runtimeDir) || JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).openclaw.version !== 'v2026.9.2')('installed native exec policy integration', () => {
  it('Full permits file changes outside the workspace and bypasses host approval floors', async () => {
    const file = fs.readdirSync(runtimeDir).find(name => name.startsWith('session-permission-exec-mode-') && name.endsWith('.js'))!;
    const runtime = await import(/* @vite-ignore */ pathToFileURL(path.join(runtimeDir, file)).href);
    const resolve = Object.values(runtime).find(value => typeof value === 'function' && value.name === 'resolveSessionPermissionCoreToolPolicy') as (input: unknown) => unknown;
    expect(resolve({ mode: 'full' })).toMatchObject({
      workspaceOnly: false, readOnly: false, applyPatchWorkspaceOnly: false,
      execMode: 'full', bypassHostApprovalFloors: true,
    });
  });

  it('preserves native permissions across payload edits and kind changes', () => {
    const file = fs.readdirSync(runtimeDir).find(name => name.startsWith('list-snapshot-revision-') && name.endsWith('.js'))!;
    const seam = seams.find((entry: { name: string }) => entry.name === 'MERGE');
    const source = transform(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), seam);
    const functions = ['applyToolsAllowPatch', 'toolsAllowEqual', 'mergeCronPayload', 'buildPayloadFromPatch']
      .map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]).join('\n');
    const merge = vm.runInNewContext(`${functions}; mergeCronPayload`);
    const full = { kind: 'agentTurn', message: 'Report', toolsAllow: ['*'], permissionMode: 'full' };
    expect(merge(full, { kind: 'agentTurn', message: 'Renamed' })).toMatchObject({ permissionMode: 'full' });
    expect(merge(full, { kind: 'agentTurn', permissionMode: 'read-only', toolsAllow: ['read'] })).toMatchObject({ permissionMode: 'read-only' });
    expect(merge({ kind: 'systemEvent', text: 'Wake' }, full)).toMatchObject(full);
    expect(merge(full, { kind: 'systemEvent', text: 'Wake' })).not.toHaveProperty('permissionMode');
  });

  it('Full disables approvals while read-only denies exec despite a global Ask floor', async () => {
    const file = fs.readdirSync(runtimeDir).find(name => name.startsWith('exec-defaults-') && name.endsWith('.js'))!;
    const runtime = await import(/* @vite-ignore */ pathToFileURL(path.join(runtimeDir, file)).href);
    const resolve = Object.values(runtime).find(value => typeof value === 'function' && value.name === 'resolveExecDefaults') as (input: unknown) => unknown;
    const base = {
      cfg: { agents: { entries: { main: {} } }, tools: { exec: { host: 'gateway', mode: 'ask' } } },
      agentId: 'main', sessionKey: 'agent:main:cron:test:run:test',
      execApprovals: { version: 1, defaults: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' }, agents: {} },
    };
    expect(resolve({ ...base, sessionEntry: { permissionMode: 'full' } })).toMatchObject({ mode: 'full', security: 'full', ask: 'off' });
    expect(resolve({ ...base, sessionEntry: { permissionMode: 'read-only' } })).toMatchObject({ mode: 'deny', security: 'deny' });
  });
});
