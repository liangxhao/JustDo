import { expect, test } from 'vitest';

import { HistoryRecoveryKind } from '../../../shared/app/startup/history';
import { classifyHistoryFailure, historySourceChanged, nativeHistoryError } from './historyFailure';

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
