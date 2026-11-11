import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NativeDatabaseRuntimeIdentity } from '../startup/upgrade/nativeDatabaseIdentity';
import { NativeRelocationSource } from './relocationNativeRuntime';

class FixtureChild extends EventEmitter {
  connected = true;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 123456;
  send = vi.fn((_value: unknown, callback?: (error: Error | null) => void) => {
    callback?.(null);
    return true;
  });
  close(code: number | null = 0, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('close', code, signal);
  }
}
const identity: NativeDatabaseRuntimeIdentity = {
  runtimeRoot: path.resolve('immutable-runtime'),
  executable: path.resolve('immutable-runtime/node-runtime/node.exe'),
  runtimeVersion: 'v2026.10.7',
  runtimeBuildId: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  schemaVersions: { state: 20, agent: 25 },
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
function fixture(overrides: Partial<ConstructorParameters<typeof NativeRelocationSource>[0]> = {}) {
  const child = new FixtureChild();
  const profileRoot = path.resolve('source');
  const snapshotDir = path.resolve('control/snapshots');
  const terminate = vi.fn(async () => {});
  const spawnChild = vi.fn(() => child as unknown as ChildProcess);
  const source = new NativeRelocationSource({
    runtimeRoot: identity.runtimeRoot,
    profileRoot,
    stateDir: path.join(profileRoot, 'openclaw/state'),
    configPath: path.join(profileRoot, 'openclaw/state/openclaw.json'),
    snapshotDir,
    admit: vi.fn(async () => identity),
    spawn: spawnChild as unknown as typeof spawn,
    terminate,
    acquireTimeoutMs: 100,
    healthTimeoutMs: 20,
    releaseTimeoutMs: 30,
    ...overrides,
  });
  const receipt = {
    type: 'held',
    identity: { runtimeBuildId: identity.runtimeBuildId },
    replaceFiles: {
      [path.join('openclaw', 'state', 'state', 'openclaw.sqlite')]: path.join(
        snapshotDir,
        '0.sqlite',
      ),
    },
    excludeRelativePaths: [path.join('openclaw', 'state', 'state', 'openclaw.sqlite-wal')],
  };
  return { child, source, receipt, spawnChild };
}
async function acquireHeld(f: ReturnType<typeof fixture>) {
  const acquiring = f.source.acquire();
  await flush();
  f.child.emit('message', f.receipt);
  await acquiring;
}
afterEach(() => vi.useRealTimers());

describe('native relocation custody', () => {
  it('keeps acquisition alive, actively checks native ownership, and joins release before success', async () => {
    const f = fixture();
    expect(f.source.retirementConfirmed).toBe(true);
    const acquiring = f.source.acquire();
    await flush();
    expect(f.source.retirementConfirmed).toBe(false);
    f.child.emit('message', f.receipt);
    expect(await acquiring).toEqual({
      replaceFiles: f.receipt.replaceFiles,
      excludeRelativePaths: f.receipt.excludeRelativePaths,
    });
    const checking = f.source.assertHeld();
    const request = f.child.send.mock.calls.at(-1)![0] as { type: string; id: string };
    expect(request.type).toBe('check');
    f.child.emit('message', { type: 'healthy', id: 'another-operation' });
    let checked = false;
    void checking.then(() => {
      checked = true;
    });
    await flush();
    expect(checked).toBe(false);
    f.child.emit('message', { type: 'healthy', id: request.id });
    await checking;
    const release = f.source.release();
    let released = false;
    void release.then(() => {
      released = true;
    });
    f.child.emit('message', { type: 'released' });
    await flush();
    expect(released).toBe(false);
    expect(f.source.retirementConfirmed).toBe(false);
    f.child.close();
    await release;
    expect(f.source.retirementConfirmed).toBe(true);
    await expect(f.source.assertHeld()).rejects.toThrow(/not active/);
  });

  it.each([
    { label: 'zero exit without a release receipt', receipt: false, code: 0, signal: null },
    { label: 'a release receipt followed by a signal', receipt: true, code: null, signal: 'SIGKILL' },
  ])('rejects $label while still recognizing process retirement', async ({ receipt, code, signal }) => {
    const f = fixture();
    await acquireHeld(f);
    const rejected = expect(f.source.release()).rejects.toThrow(/confirmed result/);
    if (receipt) f.child.emit('message', { type: 'released' });
    f.child.close(code, signal);
    await rejected;
    expect(f.source.retirementConfirmed).toBe(true);
  });

  it('rejects out-of-profile replacements and snapshots outside the owned snapshot directory', async () => {
    const f = fixture();
    const acquiring = f.source.acquire();
    const rejected = expect(acquiring).rejects.toThrow(/invalid snapshot receipt/);
    await flush();
    f.child.emit('message', {
      ...f.receipt,
      replaceFiles: { '../external.sqlite': path.resolve('unowned/snapshot') },
    });
    await rejected;
    expect(f.child.send).toHaveBeenCalledWith({ type: 'abort' }, expect.any(Function));
    f.child.close(1);
    await flush();
  });

  it('returns only a scoped path and code from a source worker failure', async () => {
    const f = fixture();
    const filename = path.resolve('source', 'openclaw/state/state/openclaw.sqlite');
    const acquiring = f.source.acquire();
    const rejected = expect(acquiring).rejects.toMatchObject({
      message: 'Native relocation custody failed.', code: 'EBUSY', path: filename,
    });
    await flush();
    f.child.emit('message', { type: 'failure', code: 'EBUSY', path: filename, message: 'private error text' });
    f.child.close(1);

    await rejected;
    expect(f.source.retirementConfirmed).toBe(true);
  });

  it('fails closed when a live child cannot prove native custody and keeps that failure after late messages', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await acquireHeld(f);
    const checking = f.source.assertHeld();
    const rejected = expect(checking).rejects.toThrow(/health/);
    const request = f.child.send.mock.calls.at(-1)![0] as { id: string };
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    f.child.emit('message', { type: 'healthy', id: request.id });
    f.child.emit('message', { type: 'released' });
    f.child.close();
    await expect(f.source.release()).rejects.toThrow(/health/);
  });

  it('keeps pending admission inside retirement accounting and prevents a late spawn after abort', async () => {
    let resolveAdmission!: (identity: NativeDatabaseRuntimeIdentity) => void;
    const f = fixture({
      admit: () =>
        new Promise(resolve => {
          resolveAdmission = resolve;
        }),
    });
    const acquiring = f.source.acquire();
    const rejected = expect(acquiring).rejects.toThrow(/interrupted/);
    expect(f.source.retirementConfirmed).toBe(false);
    await expect(f.source.abort()).rejects.toThrow(/aborted/);
    expect(f.source.retirementConfirmed).toBe(false);
    resolveAdmission(identity);
    await rejected;
    expect(f.spawnChild).not.toHaveBeenCalled();
    expect(f.source.retirementConfirmed).toBe(true);
  });

  it('does not advertise retirement after a timeout until both child close and forced retirement have joined', async () => {
    vi.useFakeTimers();
    let finishTermination!: () => void;
    const f = fixture({
      terminate: () =>
        new Promise(resolve => {
          finishTermination = resolve;
        }),
    });
    await acquireHeld(f);
    const releasing = f.source.release();
    const rejected = expect(releasing).rejects.toThrow(/retirement exceeded/);
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(f.source.retirementConfirmed).toBe(false);
    f.child.close(1);
    await flush();
    expect(f.source.retirementConfirmed).toBe(false);
    finishTermination();
    await flush();
    expect(f.source.retirementConfirmed).toBe(true);
    await expect(f.source.release()).rejects.toThrow(/retirement exceeded/);
  });
});
