import { describe, expect, it, vi } from 'vitest';

import { AcpxRuntimeProbe } from './runtime-probe.js';

describe('ACP diagnostic cleanup custody', () => {
  it('reports private probe cleanup failure to both doctor and concurrent shutdown', async () => {
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>(resolve => {
      entered = resolve;
    });
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const failure = new Error('private probe cleanup failed');
    const runtime = {
      doctor: vi.fn(async () => {
        entered();
        await pending;
        return { ok: true, message: 'ready' };
      }),
      shutdown: vi.fn(async () => {
        throw failure;
      }),
    };
    const probe = new AcpxRuntimeProbe({
      getAgent: () => 'fixture',
      createRuntime: () => runtime,
      assertRunning: () => {},
      runWithLease: (_agent, run) => run(),
    });
    const doctor = probe.doctor();
    const doctorFailure = expect(doctor).rejects.toBe(failure);
    await active;
    const stopped = probe.shutdown();
    const stopFailure = expect(stopped).rejects.toMatchObject({ errors: [failure] });
    release();
    await Promise.all([doctorFailure, stopFailure]);
    expect(probe.isHealthy()).toBe(false);
    await expect(probe.shutdown()).rejects.toMatchObject({ errors: [failure] });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it('does not turn a normal diagnostic error into a cleanup failure', async () => {
    const failure = new Error('adapter unavailable');
    const probe = new AcpxRuntimeProbe({
      getAgent: () => 'fixture',
      createRuntime: () => ({
        doctor: async () => {
          throw failure;
        },
        shutdown: async () => {},
      }),
      assertRunning: () => {},
      runWithLease: (_agent, run) => run(),
    });
    await expect(probe.doctorAgent('fixture')).rejects.toBe(failure);
    await expect(probe.shutdown()).resolves.toBeUndefined();
  });
});
