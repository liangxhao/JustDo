import { describe, expect, it } from 'vitest';

import { isBenignCompactionNoopReason, isCompactionAbortReason } from './compaction';

describe('isBenignCompactionNoopReason', () => {
  it.each(['Already compacted', 'Nothing to compact (session too small)'])(
    'recognizes the native manual preflight outcome %s',
    (reason) => expect(isBenignCompactionNoopReason(reason)).toBe(true),
  );

  it.each([undefined, null, '', 'Compaction timed out', 'Nothing to compact: provider failed']) (
    'does not hide an unknown or failed outcome %s',
    (reason) => expect(isBenignCompactionNoopReason(reason)).toBe(false),
  );
});

describe('isCompactionAbortReason', () => {
  it.each(['Compaction cancelled', 'Error: Compaction cancelled', 'Compaction aborted', 'aborted'])(
    'recognizes the exact native cancellation wrapper %s',
    reason => expect(isCompactionAbortReason(reason)).toBe(true),
  );

  it.each([undefined, '', 'Compaction timed out', 'provider failed after compaction cancelled'])(
    'preserves unknown and genuine failure reasons %s',
    reason => expect(isCompactionAbortReason(reason)).toBe(false),
  );
});
