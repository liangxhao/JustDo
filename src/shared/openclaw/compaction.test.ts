import { describe, expect, it } from 'vitest';

import { isBenignCompactionNoopReason } from './compaction';

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
