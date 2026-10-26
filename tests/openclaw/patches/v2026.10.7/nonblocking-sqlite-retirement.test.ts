import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/025-nonblocking-sqlite-retirement.cjs');
const { transform, CONTRACT } = patch.__testing;

const fixture = `function configureSqliteWalMaintenance(db, options = {}) {
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  const runCheckpoint = options.checkpoint;
  let invalidated = false;
  let error;
  const runMaintenance = run => { try { return run(); } catch (failure) { error = failure; return false; } };
  const runTickCheckpoint = mode => runCheckpoint(mode);
  const periodic = () => runWithSqliteBusyTimeout(db, 0, () => runTickCheckpoint("TRUNCATE"));
  const beginClose = () => { scope.beginClose(); return cancelSqliteWalWriteAdmission(db); };
  return {
    stop: async () => { try { await beginClose(); } finally { await scope.stop(); } },
    checkpoint: () => runMaintenance(() => runCheckpoint(checkpointMode)),
    close: closeOptions => {
      void beginClose();
      if (invalidated) return false;
      return runMaintenance(() => runCheckpoint(closeOptions?.checkpointMode ?? checkpointMode));
    },
    invalidate: () => invalidated = true,
    get error() { return error; },
    periodic
  };
}`;

function harness(source = transform(fixture)) {
  const database = { busyTimeout: 5000 };
  const checkpoint = vi.fn(() => false);
  const cancel = vi.fn();
  const beginClose = vi.fn();
  const stop = vi.fn();
  const observed: number[] = [];
  const context = vm.createContext({
    scope: { beginClose, stop },
    cancelSqliteWalWriteAdmission: cancel,
    runWithSqliteBusyTimeout: (db: typeof database, timeout: number, run: () => unknown) => {
      const previous = db.busyTimeout;
      observed.push(timeout);
      db.busyTimeout = timeout;
      try { return run(); } finally { db.busyTimeout = previous; }
    },
  });
  vm.runInContext(source, context);
  return { database, checkpoint, cancel, beginClose, stop, observed,
    maintenance: context.configureSqliteWalMaintenance(database, { checkpoint }) };
}

describe('10.7 scheduled SQLite handle retirement', () => {
  it('keeps incomplete checkpoint results and restores the original busy policy', () => {
    const h = harness();
    h.checkpoint.mockImplementation(() => {
      expect(h.database.busyTimeout).toBe(0);
      return false;
    });
    expect(h.maintenance.close()).toBe(false);
    expect(h.checkpoint).toHaveBeenCalledWith('TRUNCATE');
    expect(h.database.busyTimeout).toBe(5000);
    expect(h.cancel).toHaveBeenCalledWith(h.database);
    expect(h.beginClose).toHaveBeenCalledOnce();
    expect(h.observed).toEqual([0]);
  });

  it('joins admitted maintenance before stop settles', async () => {
    const h = harness();
    let release!: () => void;
    h.stop.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const stopping = h.maintenance.stop().then(() => { settled = true; });
    await Promise.resolve();
    expect(h.cancel).toHaveBeenCalledWith(h.database);
    expect(h.stop).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(h.checkpoint).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(settled).toBe(true);
  });

  it('preserves explicit modes, real failure results and foreground checkpoint policy', () => {
    const h = harness();
    h.checkpoint.mockReturnValue(true);
    expect(h.maintenance.close({ checkpointMode: 'PASSIVE' })).toBe(true);
    expect(h.checkpoint).toHaveBeenCalledWith('PASSIVE');
    const error = new Error('checkpoint failed');
    h.checkpoint.mockImplementation(() => { throw error; });
    expect(h.maintenance.close()).toBe(false);
    expect(h.maintenance.error).toBe(error);
    expect(h.database.busyTimeout).toBe(5000);
    h.observed.length = 0;
    h.maintenance.checkpoint();
    expect(h.observed).toEqual([]);
    h.checkpoint.mockClear();
    h.maintenance.invalidate();
    expect(h.maintenance.close()).toBe(false);
    expect(h.checkpoint).not.toHaveBeenCalled();
  });

  it('requires current cleanup and join boundaries and rejects partial or old shapes', () => {
    const current = transform(fixture);
    expect(transform(current)).toBe(current);
    expect(() => transform(current.replace(`${CONTRACT}`, 'SQLITE_RETIREMENT_CHECKPOINT_V2026_9_8'))).toThrow(/historical/);
    expect(() => transform(fixture.replace('await beginClose()', 'beginClose()'))).toThrow(/joining/);
    expect(() => transform(fixture.replace('if (invalidated) return false;', ''))).toThrow(/invalidation/);
    expect(() => transform(`// ${CONTRACT}\n${fixture}`)).toThrow(/partial/);
    expect(() => transform(current.replace('db, 0, () => runCheckpoint', 'db, 4000, () => runCheckpoint'))).toThrow(/partial/);
  });
});

describe('SQLite retirement target-set admission', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (
        path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('sqlite-retirement-admission-')
      )
        throw new Error('Unexpected SQLite retirement fixture cleanup path');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function runtime(bundle: boolean) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-retirement-admission-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'dist'));
    const native = Array.from({ length: 6 }, (_, index) =>
      path.join(root, 'dist', `wal-${index}.mjs`),
    );
    const bundleFile = bundle ? path.join(root, 'gateway-bundle.mjs') : undefined;
    const files = [...native, ...(bundleFile ? [bundleFile] : [])];
    for (const file of files) fs.writeFileSync(file, fixture);
    const snapshot = () => files.map(file => fs.readFileSync(file));
    return { root, native, bundleFile, snapshot };
  }

  function expectRejectedWithoutWrites(target: ReturnType<typeof runtime>) {
    const before = target.snapshot();
    const write = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(() => patch.applyPatch(target.root)).toThrow(/Mixed pristine and patched/);
      expect(write).not.toHaveBeenCalled();
      expect(target.snapshot()).toEqual(before);
    } finally {
      write.mockRestore();
    }
  }

  it.each([false, true])(
    'applies a fully pristine target set and keeps current bytes unchanged: bundle=%s',
    bundle => {
      const target = runtime(bundle);
      expect(() => patch.verifyPatch(target.root)).toThrow(/checkpoint missing/);
      expect(patch.applyPatch(target.root)).toHaveLength(bundle ? 7 : 6);
      const current = target.snapshot();
      expect(() => patch.verifyPatch(target.root)).not.toThrow();
      expect(patch.applyPatch(target.root)).toEqual([]);
      expect(target.snapshot()).toEqual(current);
    },
  );

  it('recognizes a current bundle after its source marker was removed', () => {
    const target = runtime(true);
    patch.applyPatch(target.root);
    const bundle = target.bundleFile!;
    fs.writeFileSync(bundle, fs.readFileSync(bundle, 'utf8').replace(`// ${CONTRACT}\n`, ''));
    const current = target.snapshot();
    expect(() => patch.verifyPatch(target.root)).not.toThrow();
    expect(patch.applyPatch(target.root)).toEqual([]);
    expect(target.snapshot()).toEqual(current);
  });

  it.each([false, true])(
    'rejects mixed native copies before any write: majorityCurrent=%s',
    majorityCurrent => {
      const target = runtime(false);
      for (const [index, file] of target.native.entries())
        if (majorityCurrent ? index !== 0 : index === 0)
          fs.writeFileSync(file, transform(fixture, file));
      expectRejectedWithoutWrites(target);
    },
  );

  it.each([false, true])(
    'rejects mixed source/bundle behavior before any write: nativeCurrent=%s',
    nativeCurrent => {
      const target = runtime(true);
      const patchedFiles = nativeCurrent ? target.native : [target.bundleFile!];
      for (const file of patchedFiles) {
        const current = transform(fixture, file);
        // Build output may retain the behavior while discarding the marker.
        fs.writeFileSync(
          file,
          file === target.bundleFile ? current.replace(`// ${CONTRACT}\n`, '') : current,
        );
      }
      expectRejectedWithoutWrites(target);
    },
  );
});
