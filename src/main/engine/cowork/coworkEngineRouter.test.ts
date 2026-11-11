import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { freezeStorageExecutionAdmission } from '../../storage/relocationAdmission';
import type { CoworkPreparedSession, CoworkRuntime } from '../types';
import { CoworkEngineRouter } from './coworkEngineRouter';

let unfreeze: (() => void) | undefined;
afterEach(() => { unfreeze?.(); unfreeze = undefined; });

function fixture() {
  const prepared: CoworkPreparedSession = { sessionKey: 'agent:main:test', gatewaySessionId: 'native-session' };
  const runtime = Object.assign(new EventEmitter(), {
    prepareSession: vi.fn().mockResolvedValue(prepared),
    startSession: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
  });
  const router = new CoworkEngineRouter({ openclawRuntime: runtime as unknown as CoworkRuntime });
  return { prepared, runtime, router };
}

describe('storage admission at the prepared-session boundary', () => {
  it('refuses a late preparation that completes after storage admission has frozen', async () => {
    const { prepared, runtime, router } = fixture();
    let resolve!: (result: CoworkPreparedSession) => void;
    runtime.prepareSession.mockReturnValueOnce(new Promise<CoworkPreparedSession>(done => { resolve = done; }));
    const preparation = router.prepareSession('session');
    const result = expect(preparation).rejects.toThrow('Execution admission is closed');

    unfreeze = freezeStorageExecutionAdmission();
    resolve(prepared);

    await result;
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
    expect(runtime.startSession).not.toHaveBeenCalled();
    unfreeze(); unfreeze = undefined;
    await Promise.resolve();
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
    // Reopening admission does not replay the denied operation. A new explicit
    // preparation may obtain its own current native binding normally.
    await expect(router.prepareSession('session')).resolves.toEqual(prepared);
    expect(runtime.prepareSession).toHaveBeenCalledTimes(2);
  });

  it('blocks new prepare/start calls while leaving explicit stop available to the owner', async () => {
    const { runtime, router } = fixture();
    unfreeze = freezeStorageExecutionAdmission();

    await expect(router.prepareSession('session')).rejects.toThrow('Execution admission is closed');
    await expect(router.startSession('session', 'task')).rejects.toThrow('Execution admission is closed');
    await expect(router.stopSession('session')).resolves.toBeUndefined();

    expect(runtime.prepareSession).not.toHaveBeenCalled();
    expect(runtime.startSession).not.toHaveBeenCalled();
    expect(runtime.stopSession).toHaveBeenCalledExactlyOnceWith('session', undefined);
  });

  it('preserves the original native preparation failure and never retries it under the freeze', async () => {
    const { runtime, router } = fixture();
    let reject!: (reason: Error) => void;
    runtime.prepareSession.mockReturnValueOnce(new Promise<CoworkPreparedSession>((_done, fail) => { reject = fail; }));
    const preparation = router.prepareSession('session');
    const failure = new Error('Native identity changed during preparation.');
    const result = expect(preparation).rejects.toBe(failure);
    unfreeze = freezeStorageExecutionAdmission();

    reject(failure);

    await result;
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
    expect(runtime.startSession).not.toHaveBeenCalled();
  });
});
