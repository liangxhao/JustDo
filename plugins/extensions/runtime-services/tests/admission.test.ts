import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXECUTION_ADMISSION_METHOD, EXECUTION_ADMISSION_MAINTENANCE_METHOD } from '../sdk/admission';

const require = createRequire(import.meta.url);
const code = buildSync({ entryPoints: [path.resolve(import.meta.dirname, '../admission/index.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['openclaw/plugin-sdk/*'] }).outputFiles[0].text;
const roots = new Set<string>();
afterEach(() => { for (const root of roots) {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('admission-receipts-')) throw new Error('Invalid cleanup');
  fs.rmSync(root, { recursive: true, force: true });
} roots.clear(); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-receipts-')); roots.add(directory);
  const methods = new Map<string, (...args: any[]) => any>();
  let policy!: (event: unknown, ctx: unknown) => unknown;
  let event!: (value: unknown) => void;
  const disposers: (() => void)[] = [];
  const retire: (() => void)[] = [];
  let live = true;
  let owner = { pluginId: 'fixture-owner', registrationId: 'registration', isCurrent: () => live,
    assertCurrent() { if (!live) throw new Error('Retired owner'); },
    onRetire(callback: () => void) { retire.push(callback); return () => undefined; } };
  const native: Record<string, unknown> = { sessionId: 'native', lifecycleRevision: 'revision' };
  const stopEvents = vi.fn();
  const output = { exports: {} as Record<string, any> };
  vm.runInNewContext(code, { module: output, exports: output.exports, structuredClone,
    require: (name: string) => name === 'openclaw/plugin-sdk/session-store-runtime' ? { getSessionEntry: () => native } : require(name) });
  const api = {
    lifecycle: { signal: new AbortController().signal, onDispose: (dispose: () => void) => { disposers.push(dispose); return () => undefined; } },
    runtime: { state: { resolveStateDir: () => directory }, events: { onAgentEvent: (callback: typeof event) => { event = callback; return stopEvents; } },
      gateway: { request: async () => ({ sessionInfo: { sessionId: 'native', hasActiveRun: false }, pendingInputs: { total: 0, items: [] }, inputReceipts: [], inputConsumptions: [] }) } },
    registerGatewayMethod: (name: string, handler: any) => methods.set(name, handler),
    registerTrustedToolPolicy: (value: { evaluate: typeof policy }) => { policy = value.evaluate; },
  };
  const service = output.exports.registerExecutionAdmission(api, { scope: 'provider', resolve: (token: string) => token === 'write' && live ? owner : undefined });
  const source = { sessionKey: 'agent:main:source', sessionId: 'native', lifecycleRevision: 'revision', runId: 'run' };
  const call = async (operation: string, params: Record<string, unknown> = {}, maintenance = false, authority = true) => {
    let value: any;
    await methods.get(maintenance ? EXECUTION_ADMISSION_MAINTENANCE_METHOD : EXECUTION_ADMISSION_METHOD)!({
      params: { ...source, ownerToken: 'write', operation, ...params }, client: { connect: { client: { mode: 'backend' } } },
      hasCurrentClientAuthority: () => authority, respond: (ok: boolean, payload: unknown, error: unknown) => { value = { ok, payload, error }; },
    });
    return value;
  };
  return { directory, service, source, native, call,
    reserve: () => call('reserve', { expectedGeneration: 0 }),
    policy: (runId = 'run') => policy({}, { sessionKey: source.sessionKey, sessionId: source.sessionId, runId }),
    terminal: (settled = true) => event({ ...source, stream: 'lifecycle', seq: 1, data: { phase: 'end', executionSettled: settled } }),
    retire: () => { live = false; for (const callback of retire) callback(); },
    restoreOwner: () => { live = true; owner = { ...owner }; },
    dispose: () => { for (const callback of disposers) callback(); }, stopEvents,
  };
}

describe('generic exact execution admission', () => {
  it('requires a proven owner for reservation and exposes only content-free generic state', async () => {
    const f = fixture();
    expect((await f.call('reserve', { expectedGeneration: 0, ownerToken: 'forged', ownerId: 'fixture-owner' })).ok).toBe(false);
    const result = await f.reserve(); expect(result.ok).toBe(true);
    expect(f.service.read(f.source)).toMatchObject({ state: 'held', receipt: { owner: { pluginId: 'fixture-owner' } } });
    expect(f.policy()).toMatchObject({ allow: false });
    expect((await f.call('verify', result.payload.receipt)).ok).toBe(true);
    expect(f.policy()).toBeUndefined();
  });
  it('does not let owner or backend absence attestations erase a verified source input', async () => {
    const f = fixture(); const result = await f.reserve(); const receipt = result.payload.receipt;
    await f.call('verify', receipt);
    expect((await f.call('abandon', { ...receipt, neverSubmitted: true })).ok).toBe(false);
    expect((await f.call('abandon', { ...receipt, neverSubmitted: true }, true)).ok).toBe(false);
    expect(f.service.read(f.source).state).toBe('held');
  });
  it('restricts only the enrolled original run after owner removal and keeps the launcher lane unknown', async () => {
    const f = fixture(); const result = await f.reserve(); await f.call('verify', result.payload.receipt);
    f.retire(); expect(f.policy()).toMatchObject({ allow: false });
    expect(f.policy('ordinary-new-run')).toBeUndefined();
    expect(f.service.read(f.source).state).toBe('unknown');
    expect((await f.call('issued', result.payload.receipt)).ok).toBe(false);
  });
  it('persists retirement for every enrolled source before a registration obtains another lease', async () => {
    const f = fixture(); await f.reserve();
    const other = { ...f.source, sessionKey: 'agent:main:other-source' };
    expect((await f.call('reserve', { ...other, expectedGeneration: 0 })).ok).toBe(true);
    f.retire(); f.restoreOwner();
    expect((await f.call('reserve', { sessionKey: 'agent:main:new-source', expectedGeneration: 0 })).ok).toBe(true);
    expect(f.service.read(f.source).state).toBe('unknown');
    expect(f.service.read(other).state).toBe('unknown');
  });
  it('does not apply an unscoped tool denial from a corrupt receipt', async () => {
    const f = fixture(); await f.reserve();
    const file = path.join(f.directory, 'runtime-services/execution-admissions', createHash('sha256').update(f.source.sessionKey).digest('hex') + '.json');
    fs.writeFileSync(file, '{bad json');
    expect(f.service.read(f.source).state).toBe('unknown');
    expect(f.policy('ordinary-new-run')).toBeUndefined();
  });
  it('does not accept a persisted released flag as settlement for an issued effect', async () => {
    const f = fixture(); const result = await f.reserve();
    const file = path.join(f.directory, 'runtime-services/execution-admissions', createHash('sha256').update(f.source.sessionKey).digest('hex') + '.json');
    fs.writeFileSync(file, JSON.stringify({ ...result.payload.receipt, state: 'released', verified: true, effectIssued: true }));
    expect(f.service.read(f.source).state).toBe('unknown');
    expect((await f.reserve()).ok).toBe(false);
    expect(f.policy('ordinary-new-run')).toBeUndefined();
  });
  it('requires native whole-run evidence and a stored cleanup receipt, then supports exact backend maintenance after retirement', async () => {
    const f = fixture(); const result = await f.reserve(); const receipt = result.payload.receipt;
    expect((await f.call('release', { ...receipt, cleanupComplete: true })).ok).toBe(false);
    await f.call('cleanup', { ...receipt, receiptId: 'cleanup' }); f.terminal(false);
    expect((await f.call('release', { ...receipt, receiptId: 'cleanup' })).ok).toBe(false);
    f.retire(); f.terminal();
    expect((await f.call('reserve', { ...receipt, receiptId: 'cleanup' }, true)).ok).toBe(false);
    expect((await f.call('cleanup', { ...receipt, receiptId: 'backend-cleanup' }, true, false)).ok).toBe(false);
    expect((await f.call('cleanup', { ...receipt, receiptId: 'backend-cleanup' }, true)).ok).toBe(true);
    expect((await f.call('release', { ...receipt, receiptId: 'backend-cleanup' }, true)).ok).toBe(true);
    expect(f.service.read(f.source).state).toBe('clear'); f.dispose(); expect(f.stopEvents).toHaveBeenCalledOnce();
  });
  it('never grants maintenance access to a replacement incarnation or a mismatched receipt', async () => {
    const f = fixture(); const result = await f.reserve(); const receipt = result.payload.receipt;
    expect((await f.call('revoke', { ...receipt, sessionId: 'replacement' }, true)).ok).toBe(false);
    expect((await f.call('revoke', { ...receipt, id: 'other' }, true)).ok).toBe(false);
    expect(f.service.read(f.source).state).toBe('held');
  });
  it.each(['sessionId', 'lifecycleRevision'])('rejects old exact maintenance parameters after native %s changes', async field => {
    const f = fixture(); const result = await f.reserve(); const receipt = result.payload.receipt;
    await f.call('cleanup', { ...receipt, receiptId: 'cleanup' }); f.terminal();
    f.native[field] = 'replacement';
    for (const operation of ['revoke', 'cleanup', 'release', 'abandon'])
      expect((await f.call(operation, { ...receipt, receiptId: 'cleanup', neverSubmitted: true }, true)).ok).toBe(false);
    expect(f.service.read(f.source).state).toBe('unknown');
  });
});
