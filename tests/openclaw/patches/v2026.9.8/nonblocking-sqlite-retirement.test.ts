import { createRequire } from 'node:module';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { transform, CONTRACT } =
  require('../../../../scripts/patches/v2026.9.8/043-nonblocking-sqlite-retirement.cjs').__testing;

const fixture = `function configureSqliteWalMaintenance(db, options = {}) {
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  const runCheckpoint = options.checkpoint;
  let error;
  const runMaintenance = operation => {
    try { return operation(); }
    catch (failure) { error = failure; return false; }
  };
  let timer = 1;
  let invalidated = false;
  const periodic = () => runWithSqliteBusyTimeout(db, 0, () => runCheckpoint("TRUNCATE"));
  return {
    checkpoint: () => runMaintenance(() => runCheckpoint(checkpointMode)),
    close: closeOptions => {
      clearInterval(timer ?? void 0);
      timer = null;
      cancelSqliteWalWriteAdmission(db);
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
  const clear = vi.fn();
  const observed: number[] = [];
  const scope = vm.createContext({
    clearInterval: clear,
    cancelSqliteWalWriteAdmission: cancel,
    runWithSqliteBusyTimeout: (db: typeof database, timeout: number, run: () => unknown) => {
      const previous = db.busyTimeout;
      observed.push(timeout);
      db.busyTimeout = timeout;
      try {
        return run();
      } finally {
        db.busyTimeout = previous;
      }
    },
  });
  vm.runInContext(source, scope);
  const maintenance = scope.configureSqliteWalMaintenance(database, {
    checkpoint,
  });
  return { database, checkpoint, cancel, clear, observed, maintenance };
}

describe('SQLite handle retirement', () => {
  it('uses an immediate close checkpoint and keeps its real blocked result and busy policy', () => {
    const h = harness();
    h.checkpoint.mockImplementation(() => {
      expect(h.database.busyTimeout).toBe(0);
      return false;
    });
    expect(h.maintenance.close()).toBe(false);
    expect(h.checkpoint).toHaveBeenCalledWith('TRUNCATE');
    expect(h.database.busyTimeout).toBe(5000);
    expect(h.cancel).toHaveBeenCalledWith(h.database);
    expect(h.clear).toHaveBeenCalledWith(1);
    expect(h.observed).toEqual([0]);
  });

  it('preserves explicit checkpoint modes and success', () => {
    const h = harness();
    h.checkpoint.mockReturnValue(true);
    expect(h.maintenance.close({ checkpointMode: 'PASSIVE' })).toBe(true);
    expect(h.checkpoint).toHaveBeenCalledWith('PASSIVE');
    expect(h.database.busyTimeout).toBe(5000);
  });

  it('restores the policy after a checkpoint error without claiming a successful close', () => {
    const h = harness();
    const failure = new Error('checkpoint failed');
    h.checkpoint.mockImplementation(() => {
      throw failure;
    });
    expect(h.maintenance.close()).toBe(false);
    expect(h.maintenance.error).toBe(failure);
    expect(h.database.busyTimeout).toBe(5000);
  });

  it('preserves invalidation and explicit foreground checkpoint behavior', () => {
    const h = harness();
    h.maintenance.checkpoint();
    expect(h.observed).toEqual([]);
    h.checkpoint.mockClear();
    h.maintenance.invalidate();
    expect(h.maintenance.close()).toBe(false);
    expect(h.checkpoint).not.toHaveBeenCalled();
    expect(h.observed).toEqual([]);
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it('accepts only its exact current shape and markerless final bundle', () => {
    const patched = transform(fixture);
    expect(transform(patched)).toBe(patched);
    const bundled = patched.replace(`// ${CONTRACT}\n`, '');
    expect(transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    expect(() => transform(bundled)).toThrow('missing');
    expect(() => transform(patched.replace(CONTRACT, CONTRACT.replace('9_8', '9_7')))).toThrow(
      'historical',
    );
    expect(() =>
      transform(
        patched.replace(
          'db, 0, () => runCheckpoint(closeOptions',
          'db, 10, () => runCheckpoint(closeOptions',
        ),
      ),
    ).toThrow('partial');
    expect(() =>
      transform(fixture.replace('closeOptions?.checkpointMode', 'options.checkpointMode')),
    ).toThrow('mode preservation');
    expect(() => transform(fixture + fixture)).toThrow('topology');
    expect(() => transform(fixture.replace('cancelSqliteWalWriteAdmission(db);', ''))).toThrow(
      'cleanup guards',
    );
  });

  it('handles the native minified close expression without changing its guards', () => {
    const minified = fixture
      .replaceAll('db', 'Ot')
      .replaceAll('closeOptions', 'Kt')
      .replace(
        /close: Kt => \{[\s\S]*?\n    \},/,
        'close: Kt => (clearInterval(timer ?? void 0), timer = null, cancelSqliteWalWriteAdmission(Ot), !invalidated && runMaintenance(() => runCheckpoint(Kt?.checkpointMode ?? checkpointMode))),',
      );
    expect(transform(transform(minified))).toBe(transform(minified));
    const h = harness(transform(minified));
    expect(h.maintenance.close()).toBe(false);
    expect(h.observed).toEqual([0]);
    expect(h.cancel).toHaveBeenCalledWith(h.database);
  });
});
