import { expect, test } from 'vitest';

import { HistoryRecoveryKind } from '../../../shared/app/startup/history';
import { classifyHistoryFailure, getHistoryLockDiagnostic, historySourceChanged, nativeHistoryError, rememberHistoryLockDiagnostic } from './historyFailure';

test('keeps copied lock observations separate from the unchanged filesystem exception', () => {
  const error = Object.freeze(Object.assign(new Error('original rename failure'), { code: 'EPERM' }));
  const diagnostic = { targetPath: 'C:/profile/openclaw', available: true,
    processes: [{ name: 'observed process', pid: 42, isMainProcess: false }] };
  rememberHistoryLockDiagnostic(error, diagnostic);
  diagnostic.processes[0].name = 'later mutation';
  const first = getHistoryLockDiagnostic(error)!;
  expect(first.processes[0].name).toBe('observed process');
  first.processes[0].pid = 123;
  expect(getHistoryLockDiagnostic(error)?.processes[0].pid).toBe(42);
  expect(error.message).toBe('original rename failure');
  expect(error.code).toBe('EPERM');
  expect(Object.keys(error)).toEqual(['code']);
});

test('reads lock observations through bounded error causes and safely handles cycles', () => {
  const cause = new Error('original failure');
  const diagnostic = { targetPath: 'C:/profile/openclaw', available: false, processes: [] };
  rememberHistoryLockDiagnostic(cause, diagnostic);
  expect(getHistoryLockDiagnostic(new Error('wrapped failure', { cause }))).toEqual(diagnostic);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(getHistoryLockDiagnostic(cycle)).toBeUndefined();
  expect(getHistoryLockDiagnostic('EPERM')).toBeUndefined();
});

test.each([
  ['ENOSPC', HistoryRecoveryKind.Space],
  ['EDQUOT', HistoryRecoveryKind.Space],
  ['SQLITE_FULL', HistoryRecoveryKind.Space],
  ['SQLITE_BUSY', HistoryRecoveryKind.Busy],
  ['SQLITE_BUSY_SNAPSHOT', HistoryRecoveryKind.Busy],
  ['SQLITE_LOCKED_SHAREDCACHE', HistoryRecoveryKind.Busy],
  ['EBUSY', HistoryRecoveryKind.Busy],
  ['EPERM', HistoryRecoveryKind.Access],
  ['EACCES', HistoryRecoveryKind.Access],
  ['EIO', HistoryRecoveryKind.Other],
])('explains %s without changing the original error', (code, kind) => {
  const error = Object.assign(new Error('original failure'), { code });
  expect(classifyHistoryFailure(error)).toBe(kind);
  expect(error.message).toBe('original failure');
  expect(error.code).toBe(code);
});

test('native issue envelopes and bounded stderr retain advice without inspecting transcript messages', () => {
  const full = nativeHistoryError('Import failed', {
    targets: [{ issues: [{ code: 'import_failed', message: 'database or disk is full' }] }],
  });
  expect(classifyHistoryFailure(full)).toBe(HistoryRecoveryKind.Space);
  expect(full.message).toBe('Import failed');
  expect(
    classifyHistoryFailure(
      nativeHistoryError('Verify failed', 'Error: SQLITE_BUSY: database is locked'),
    ),
  ).toBe(HistoryRecoveryKind.Busy);
  expect(
    classifyHistoryFailure(
      nativeHistoryError('Verify failed', { messages: [{ content: 'SQLITE_BUSY' }] }),
    ),
  ).toBe(HistoryRecoveryKind.Other);
});

test('keeps source mutation distinct from a filesystem lock and inspects bounded cause chains', () => {
  expect(classifyHistoryFailure(historySourceChanged('still writing'))).toBe(
    HistoryRecoveryKind.Changing,
  );
  const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  expect(classifyHistoryFailure(new Error('backup failed', { cause }))).toBe(
    HistoryRecoveryKind.Space,
  );
  const cycle = { code: 'UNKNOWN', cause: {} as unknown };
  cycle.cause = cycle;
  expect(classifyHistoryFailure(cycle)).toBe(HistoryRecoveryKind.Other);
});
