import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StartupCompatibilityErrorCode } from '../../../shared/app/startup/versionPolicy';
import type { NativeDatabaseRuntimeIdentity } from './nativeDatabaseIdentity';
import { NativeDatabaseUpgradeRuntime } from './nativeDatabaseUpgradeRuntime';
import { NATIVE_DATABASE_UPGRADE_SOURCE } from './nativeDatabaseUpgradeSource';

class FixtureChild extends EventEmitter {
  connected = true;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 123456;
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => { callback?.(null); return true; });
  close(code = 0, signal: string | null = null): void {
    this.exitCode = code; this.signalCode = signal; this.connected = false;
    this.emit('close', code, signal);
  }
}
const identity: NativeDatabaseRuntimeIdentity = { runtimeRoot: path.resolve('immutable-runtime'),
  executable: path.resolve('immutable-runtime/node-runtime/node.exe'), runtimeVersion: 'v2026.10.6',
  runtimeBuildId: 'b'.repeat(64), manifestSha256: 'b'.repeat(64), schemaVersions: { state: 20, agent: 25 } };
const inventory = [{ agentId: 'main', path: path.resolve('state/agent.sqlite'), realPath: path.resolve('state/agent.sqlite'), dev: '1', ino: '2' }];
function fixture() {
  const children: FixtureChild[] = [];
  const spawnChild = vi.fn(() => { const child = new FixtureChild(); children.push(child); return child as unknown as ChildProcess; });
  const admit = vi.fn(async () => identity);
  const readDeliveryIdentity = vi.fn(async () => ({
    runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId,
  }));
  const stoppedGateway = vi.fn(() => true);
  const terminate = vi.fn(async () => {});
  const runtime = new NativeDatabaseUpgradeRuntime({ getRuntimeRoot: () => identity.runtimeRoot,
    stateDir: path.resolve('state'), configPath: path.resolve('state/openclaw.json'),
    gatewayStopped: stoppedGateway, admit, readDeliveryIdentity, spawn: spawnChild as unknown as typeof spawn,
    terminate, inspectTimeoutMs: 100, upgradeTimeoutMs: 1000, abortGraceMs: 30, retirementObservationMs: 50 });
  return { runtime, children, spawnChild, admit, readDeliveryIdentity, stoppedGateway, terminate };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function receipt(child: FixtureChild, changes: Record<string, unknown> = {}): void {
  child.emit('message', { type: 'result', operation: 'inspect', identity,
    needsUpgrade: false, verified: true, inventory, ...changes });
}
afterEach(() => vi.useRealTimers());

describe('native database startup owner', () => {
  it('reads delivery metadata without native admission, Gateway ownership checks or subprocesses', async () => {
    const f = fixture();
    await expect(f.runtime.deliveryIdentity()).resolves.toEqual({
      runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId,
    });
    expect(f.readDeliveryIdentity).toHaveBeenCalledExactlyOnceWith(identity.runtimeRoot);
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.spawnChild).not.toHaveBeenCalled();
    expect(f.stoppedGateway).not.toHaveBeenCalled();

    await f.runtime.identity();
    expect(f.admit).toHaveBeenCalledOnce();
  });
  it('rejects metadata reads before and after shutdown without publishing a late identity', async () => {
    const stopped = fixture();
    await stopped.runtime.stop();
    await expect(stopped.runtime.deliveryIdentity()).rejects.toThrow(/interrupted/);
    expect(stopped.readDeliveryIdentity).not.toHaveBeenCalled();

    const pending = fixture();
    let release!: (value: Awaited<ReturnType<typeof pending.readDeliveryIdentity>>) => void;
    pending.readDeliveryIdentity.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reading = pending.runtime.deliveryIdentity();
    const rejected = expect(reading).rejects.toThrow(/interrupted/);
    await pending.runtime.stop();
    release({ runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId });
    await rejected;
    expect(pending.admit).not.toHaveBeenCalled();
    expect(pending.spawnChild).not.toHaveBeenCalled();
  });
  it('reads immutable identity without launching native storage or building a Gateway environment', async () => {
    const f = fixture();
    await expect(f.runtime.identity()).resolves.toEqual({ runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId });
    expect(f.spawnChild).not.toHaveBeenCalled();
    expect(f.stoppedGateway).not.toHaveBeenCalled();
  });
  it('joins offline canonical preparation and binds it to the inspected fleet before Gateway admission', async () => {
    const f = fixture();
    const inspection = f.runtime.inspect(); await flush();
    receipt(f.children[0]); f.children[0].close(); await inspection;
    let settled = false;
    const preparing = f.runtime.prepareCanonical().then(() => { settled = true; });
    await flush();
    const args = f.spawnChild.mock.calls[1] as unknown as [string, string[]];
    expect(JSON.parse(args[1].at(-1)!)).toMatchObject({ operation: 'prepare', expectedInventory: inventory, identity });
    const child = f.children[1];
    receipt(child, { operation: 'prepare' }); await flush();
    expect(settled).toBe(false);
    await expect(f.runtime.inspect()).rejects.toThrow(/Another native/);
    child.close(); await preparing;
    expect(settled).toBe(true);
  });
  it.each([
    { needsUpgrade: true, verified: false },
    { needsUpgrade: false, verified: false },
  ])('rejects an unverified canonical preparation receipt: %j', async result => {
    const f = fixture();
    const preparing = f.runtime.prepareCanonical();
    const rejected = expect(preparing).rejects.toThrow(/canonical validation was not verified/);
    await flush(); receipt(f.children[0], { operation: 'prepare', ...result });
    f.children[0].close(); await rejected;
  });
  it('cannot admit canonical preparation after Gateway ownership changes while the child closes', async () => {
    const f = fixture();
    const preparing = f.runtime.prepareCanonical();
    const rejected = expect(preparing).rejects.toThrow(/Gateway ownership changed/);
    await flush(); receipt(f.children[0], { operation: 'prepare' });
    f.stoppedGateway.mockReturnValue(false);
    f.children[0].close(); await rejected;
  });
  it('joins child retirement before accepting its native receipt and carries the exact inspected inventory into upgrade', async () => {
    const f = fixture(); let settled = false;
    const pending = f.runtime.inspect().then(value => { settled = true; return value; });
    await flush(); const child = f.children[0]; receipt(child, { needsUpgrade: true, verified: false }); await flush();
    expect(settled).toBe(false); child.close(); await expect(pending).resolves.toEqual({ needsUpgrade: true });
    const activity = vi.fn(); const upgrade = f.runtime.upgrade(activity); await flush();
    const args = f.spawnChild.mock.calls[1] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(JSON.parse(args[1].at(-1)!).expectedInventory).toEqual(inventory);
    expect(args[2].env.OPENCLAW_STATE_DIR).toBe(path.resolve('state'));
    const next = f.children[1]; next.emit('message', { type: 'activity', activity: 'nativeBackup' });
    receipt(next, { operation: 'upgrade' }); next.close(); await upgrade;
    expect(activity).toHaveBeenCalledWith('nativeBackup');
  });
  it.each([
    { identity: { ...identity, runtimeBuildId: 'old' } }, { operation: 'other' },
    { inventory: [{ path: '/missing-facts' }] }, { needsUpgrade: false, verified: false },
    { inventory: [{ ...inventory[0], agentId: 1 }] }, { inventory: [{ ...inventory[0], path: '' }] },
    { inventory: [{ ...inventory[0], dev: '0' }] }, { inventory: [inventory[0], { ...inventory[0] }] },
  ])('rejects mismatched or unverified native receipts: %j', async changes => {
    const f = fixture(); const pending = f.runtime.inspect(); const checked = expect(pending).rejects.toThrow();
    await flush(); receipt(f.children[0], changes); f.children[0].close(); await checked;
  });
  it('does not treat nonzero exit, a missing receipt, or a native failure as success', async () => {
    for (const mode of ['exit', 'missing', 'failure'] as const) {
      const f = fixture(); const pending = f.runtime.inspect(); const checked = expect(pending).rejects.toThrow();
      await flush(); const child = f.children[0];
      if (mode !== 'missing') receipt(child);
      if (mode === 'failure') child.emit('message', { type: 'failure', message: 'native ownership refused' });
      child.close(mode === 'exit' ? 1 : 0); await checked;
    }
  });
  it.each([StartupCompatibilityErrorCode.NativeSchemaUnsupported, 'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_CANTOPEN', 'ENOSPC', 'EDQUOT', 'EBUSY',
    'EAGAIN', 'ETXTBSY', 'EACCES', 'EPERM', 'EROFS', 'foreign-code', 'SQLITE_BUSY_FAKE', undefined])('only forwards an allowed structured native failure code: %j', async code => {
    const f = fixture(); const pending = f.runtime.inspect();
    const checked = pending.catch(error => error);
    await flush(); f.children[0].emit('message', { type: 'failure', code, message: 'newer database schema' });
    f.children[0].close(1); const error = await checked;
    expect(error).toBeInstanceOf(Error);
    const input = JSON.parse((f.spawnChild.mock.calls[0] as unknown as [string, string[]])[1].at(-1)!);
    expect(error.code).toBe(input.nativeFailureCodes.includes(code) ? code : undefined);
  });
  it('normalizes actual child structured SQLite/errno errors, but never message text or an untyped lease name', async () => {
    const f = fixture(); const pending = f.runtime.inspect(); const checked = pending.catch(error => error);
    await flush(); f.children[0].close(1); await checked;
    const input = JSON.parse((f.spawnChild.mock.calls[0] as unknown as [string, string[]])[1].at(-1)!);
    const source = ts.createSourceFile('child.mjs', NATIVE_DATABASE_UPGRADE_SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = source.statements.flatMap(statement => ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations] : []).find(node => node.name.getText(source) === 'nativeFailureCode');
    expect(declaration?.initializer).toBeDefined();
    const normalize = runInNewContext('(' + declaration!.initializer!.getText(source) + ')', { input }) as (error: unknown) => string | undefined;
    for (const [errcode, expected] of [[5, 'SQLITE_BUSY'], [517, 'SQLITE_BUSY'], [262, 'SQLITE_LOCKED'],
      [8, 'SQLITE_READONLY'], [13, 'SQLITE_FULL'], [14, 'SQLITE_CANTOPEN']] as const)
      expect(normalize({ cause: { code: 'ERR_SQLITE_ERROR', errcode } })).toBe(expected);
    expect(normalize(new AggregateError([{ code: 'ENOSPC' }]))).toBe('ENOSPC');
    expect(normalize({ code: 'EPERM' })).toBe('EPERM');
    for (const error of [{ code: 'ERR_SQLITE_ERROR', errcode: 11 }, { code: 'ERR_SQLITE_ERROR', errcode: 5.5 },
      { code: 'ERR_SQLITE_ERROR', errcode: '5' }, { errcode: 5 }, { message: 'SQLITE_BUSY: database is locked' },
      { name: 'OpenClawAgentDatabaseLeaseActiveError' }, { code: 'SQLITE_BUSY_FAKE' }])
      expect(normalize(error)).toBeUndefined();
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect(normalize(cycle)).toBeUndefined();
  });
  it('rejects duplicate receipts and concurrent operations without a second submission', async () => {
    const f = fixture(); const pending = f.runtime.inspect(); const checked = expect(pending).rejects.toThrow(/invalid receipt/);
    await flush(); await expect(f.runtime.inspect()).rejects.toThrow(/Another native/);
    receipt(f.children[0]); receipt(f.children[0]); f.children[0].close(); await checked;
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  });
  it('rechecks Gateway ownership after immutable runtime admission and after child close', async () => {
    const f = fixture(); f.stoppedGateway.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(f.runtime.inspect()).rejects.toThrow(/admission changed/); expect(f.spawnChild).not.toHaveBeenCalled();
    const g = fixture(); const pending = g.runtime.inspect(); const checked = expect(pending).rejects.toThrow(/ownership changed/);
    await flush(); receipt(g.children[0]); g.stoppedGateway.mockReturnValue(false); g.children[0].close(); await checked;
  });
  it('aborts and joins on stop; a prior receipt cannot turn interrupted maintenance into success', async () => {
    const f = fixture(); const pending = f.runtime.inspect(); const checked = expect(pending).rejects.toThrow(/interrupted/);
    await flush(); receipt(f.children[0]); let stopped = false;
    const stop = f.runtime.stop().then(() => { stopped = true; }); await flush();
    expect(stopped).toBe(false); expect(f.children[0].send).toHaveBeenCalledWith({ type: 'abort' }, expect.any(Function));
    f.children[0].close(); await checked; await stop; expect(stopped).toBe(true);
    await expect(f.runtime.inspect()).rejects.toThrow(/stopped Gateway|interrupted/);
  });
  it('bounds an unresponsive inspection, requests cooperative cancellation, then joins forced retirement as unknown', async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = f.runtime.inspect(); const checked = expect(pending).rejects.toThrow(/deadline|unconfirmed/);
    await flush(); await vi.advanceTimersByTimeAsync(100);
    expect(f.children[0].send).toHaveBeenCalledWith({ type: 'abort' }, expect.any(Function));
    expect(f.terminate).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(30);
    expect(f.terminate).toHaveBeenCalledWith(f.children[0]);
    receipt(f.children[0]); f.children[0].close(0); await checked;
  });
  it.each(['no-close', 'failed-helper', 'helper-pending-after-close'] as const)('keeps unknown custody and permanently blocks retries when retirement is unconfirmed: %s', async mode => {
    vi.useFakeTimers(); const f = fixture();
    let release: (() => void) | undefined;
    if (mode === 'failed-helper') f.terminate.mockRejectedValueOnce(new Error('permission denied'));
    if (mode === 'helper-pending-after-close') f.terminate.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.runtime.inspect(); const checked = expect(pending).rejects.toThrow(/retirement could not be confirmed/);
    await flush(); await vi.advanceTimersByTimeAsync(130);
    if (mode === 'helper-pending-after-close') { receipt(f.children[0]); f.children[0].close(); }
    await vi.advanceTimersByTimeAsync(50); await checked;
    await expect(f.runtime.inspect()).rejects.toThrow(/restart is required/);
    await expect(f.runtime.stop()).rejects.toThrow(/restart is required/);
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
    if (mode !== 'helper-pending-after-close') f.children[0].close(1);
    release?.(); await flush();
    await expect(f.runtime.identity()).rejects.toThrow(/restart is required/);
    await expect(f.runtime.deliveryIdentity()).rejects.toThrow(/restart is required/);
    expect(f.readDeliveryIdentity).not.toHaveBeenCalled();
  });
});
