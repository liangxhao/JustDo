import { describe, expect, test, vi } from 'vitest';

import { MANAGED_EXECUTION_DESCRIPTOR, managedSubagent } from '../../sdk/execution';

function fixture() {
  const controller = new AbortController();
  let current = true;
  const methods = {
    run: vi.fn(function (this: unknown, params: unknown) {
      expect(this).toBe(methods);
      return Promise.resolve({ runId: 'native-run', params });
    }),
    describeRun: vi.fn(function (this: unknown) {
      expect(this).toBe(methods);
      return Promise.resolve({ runId: 'native-run', state: 'running', executionSettled: true, cleanupSettled: false });
    }),
    cancelRun: vi.fn(function (this: unknown) {
      expect(this).toBe(methods);
      return Promise.resolve({ accepted: true });
    }),
  };
  const api = { runtime: { subagent: methods }, lifecycle: { signal: controller.signal } };
  const capability = {
    isCurrent: () => current,
    getManagedExecutionDescriptor: () => MANAGED_EXECUTION_DESCRIPTOR,
  };
  return { api, methods, capability, controller, retire: () => { current = false; } };
}

describe('caller-bound managed execution', () => {
  test('preserves the original receiver, arguments and separate execution/cleanup evidence', async () => {
    const f = fixture();
    const executor = managedSubagent(f.api, f.capability);
    const params = { sessionKey: 'agent:worker:owned', message: 'fixture', managedToolsLifetime: 'run' as const };
    await executor.run(params);
    expect(f.methods.run).toHaveBeenCalledExactlyOnceWith({ ...params, assertCurrent: expect.any(Function) });
    expect(params).not.toHaveProperty('assertCurrent');
    await expect(executor.describeRun({ runId: 'native-run' })).resolves.toMatchObject({
      executionSettled: true, cleanupSettled: false,
    });
    await executor.cancelRun({ runId: 'native-run' });
    expect(f.methods.cancelRun).toHaveBeenCalledExactlyOnceWith({ runId: 'native-run' });
  });

  test.each([
    undefined,
    { ...MANAGED_EXECUTION_DESCRIPTOR, version: 2 },
    { ...MANAGED_EXECUTION_DESCRIPTOR, runToolCleanup: false },
    { ...MANAGED_EXECUTION_DESCRIPTOR, implicitGrant: true },
  ])('does not infer support from native method shape: %j', descriptor => {
    const f = fixture();
    expect(() => managedSubagent(f.api, {
      ...f.capability,
      getManagedExecutionDescriptor: () => descriptor as typeof MANAGED_EXECUTION_DESCRIPTOR,
    })).toThrow('Managed execution capability is unavailable');
    expect(f.methods.run).not.toHaveBeenCalled();
  });

  test('retired bindings and consumer disposal fence captured methods', () => {
    const f = fixture();
    const executor = managedSubagent(f.api, f.capability);
    const describe = executor.describeRun;
    f.retire();
    expect(() => describe({ runId: 'native-run' })).toThrow('retired');
    expect(f.methods.describeRun).not.toHaveBeenCalled();
    const other = fixture();
    const active = managedSubagent(other.api, other.capability);
    other.controller.abort();
    expect(() => active.cancelRun({ runId: 'native-run' })).toThrow('retired');
    expect(other.methods.cancelRun).not.toHaveBeenCalled();
  });

  test('composes the caller fence with provider retirement at native admission after an await', async () => {
    const f = fixture();
    const callerFence = vi.fn();
    let admit!: () => void;
    f.methods.run.mockImplementationOnce(async (input: unknown) => {
      await new Promise<void>(resolve => { admit = resolve; });
      (input as { assertCurrent(): void }).assertCurrent();
      return { runId: 'native-run', params: input };
    });
    const executor = managedSubagent(f.api, f.capability);
    const pending = executor.run({ sessionKey: 'agent:worker:owned', message: 'fixture', managedToolsLifetime: 'run', assertCurrent: callerFence });
    f.retire();
    admit();
    await expect(pending).rejects.toThrow('retired');
    expect(callerFence).not.toHaveBeenCalled();
    expect(f.methods.run).toHaveBeenCalledOnce();
  });

  test('retains the original caller admission check and rejects a missing lifecycle signal', async () => {
    const f = fixture();
    f.methods.run.mockImplementationOnce(async (input: unknown) => {
      (input as { assertCurrent(): void }).assertCurrent();
      return { runId: 'native-run', params: input };
    });
    const callerError = new Error('Caller scope retired');
    const callerFence = vi.fn(() => { throw callerError; });
    await expect(managedSubagent(f.api, f.capability).run({ sessionKey: 'agent:worker:owned', message: 'fixture', managedToolsLifetime: 'run', assertCurrent: callerFence })).rejects.toBe(callerError);
    expect(callerFence).toHaveBeenCalledOnce();
    expect(() => managedSubagent({ ...f.api, lifecycle: {} }, f.capability)).toThrow('retired');
  });

  test('native synchronous and asynchronous failures propagate without retry', async () => {
    const f = fixture();
    const executor = managedSubagent(f.api, f.capability);
    const unknown = new Error('Native result is unknown');
    f.methods.run.mockImplementationOnce(() => { throw unknown; });
    const params = { sessionKey: 'agent:worker:owned', message: 'fixture', managedToolsLifetime: 'run' as const };
    expect(() => executor.run(params)).toThrow(unknown);
    f.methods.run.mockRejectedValueOnce(unknown);
    await expect(executor.run(params)).rejects.toBe(unknown);
    expect(f.methods.run).toHaveBeenCalledTimes(2);
  });

  test('an incompatible consumer executor cannot use another provider executor', () => {
    const f = fixture();
    Reflect.deleteProperty(f.methods, 'describeRun');
    expect(() => managedSubagent(f.api, f.capability)).toThrow('native executor does not implement');
    expect(f.methods.run).not.toHaveBeenCalled();
  });
});
