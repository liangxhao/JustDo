import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/keyed-async-queue', () => ({
  KeyedAsyncQueue: class {
    enqueue<T>(_key: string, run: () => Promise<T>): Promise<T> {
      return run();
    }
  },
}));
vi.mock('../runtime-api.js', () => ({
  AcpRuntimeError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { AcpxGenerationRegistry } from '../src/runtime-generations.js';

function fixture() {
  const store = { isFresh: () => false, markFresh: vi.fn() };
  const delegate = { shutdown: vi.fn(async () => {}) };
  const registry = new AcpxGenerationRegistry(store, delegate as never, () => delegate as never);
  return { store, registry };
}

describe('ACPX generation custody', () => {
  it('retires an empty read without creating a reset intent or changing persistent state', () => {
    const { registry, store } = fixture();
    const generation = registry.currentGeneration('empty-session');
    const release = registry.retainGenerationOperation(generation, 'lookup');

    release();

    expect(registry.currentGeneration('empty-session')).not.toBe(generation);
    expect(() => registry.assertCurrentGeneration(generation)).toThrow(/superseded/);
    expect(store.markFresh).not.toHaveBeenCalled();
  });

  it('retains the reset fence for a returned persisted-history handle until explicit reset', () => {
    const { registry, store } = fixture();
    const generation = registry.currentGeneration('history-session');
    const release = registry.retainGenerationOperation(generation, 'history-record');
    generation.admitted = true;

    release();

    expect(registry.currentGeneration('history-session')).toBe(generation);
    registry.prepareFresh('history-session');
    const successor = registry.currentGeneration('history-session');
    expect(successor).not.toBe(generation);
    expect(() => registry.assertCurrentGeneration(generation)).toThrow(/superseded/);
    expect(() => registry.assertCurrentGeneration(successor)).not.toThrow();
    expect(store.markFresh).toHaveBeenCalledExactlyOnceWith('history-session');
  });

  it('keeps an in-flight empty read alive until its final consumer releases custody', () => {
    const { registry } = fixture();
    const generation = registry.currentGeneration('pending-read');
    const first = registry.retainGenerationOperation(generation, 'record');
    const second = registry.retainGenerationOperation(generation, 'record');

    first();
    expect(registry.currentGeneration('pending-read')).toBe(generation);
    expect(() => registry.assertCurrentGeneration(generation)).not.toThrow();
    second();

    expect(registry.currentGeneration('pending-read')).not.toBe(generation);
    expect(() => registry.assertCurrentGeneration(generation)).toThrow(/superseded/);
  });

  it('preserves an accepted admission after later failed reads', async () => {
    const { registry } = fixture();
    let admitted: ReturnType<AcpxGenerationRegistry['currentGeneration']> | undefined;
    await registry.runAdmission('accepted-session', async generation => {
      admitted = generation;
    });

    await expect(
      registry.runAdmission('accepted-session', async () => {
        throw new Error('synthetic read failure');
      }),
    ).rejects.toThrow('synthetic read failure');

    expect(registry.currentGeneration('accepted-session')).toBe(admitted);
    expect(() => registry.assertCurrentGeneration(admitted!)).not.toThrow();
  });
});
