import { describe, expect, test } from 'vitest';

import {
  isInternalSubagentLabel,
  reconcileSubagentLabel,
} from '@/features/cowork/components/subagentLabel';

const subagent = {
  sessionKey: 'agent:main:subagent:a263de4c-ea07-47f2-b8ce-108053a89f70',
};

describe('reconcileSubagentLabel', () => {
  test('upgrades a dated session id fallback to a structured task name', () => {
    expect(reconcileSubagentLabel(subagent, 'bb6214b9 (2026-07-16)', 'blessing-4')).toBe(
      'blessing-4',
    );
  });

  test('upgrades a session key suffix fallback to a structured task name', () => {
    expect(
      reconcileSubagentLabel(subagent, 'a263de4c-ea07-47f2-b8ce-108053a89f70', 'blessing-4'),
    ).toBe('blessing-4');
  });

  test('keeps a stable task name when a later response temporarily falls back', () => {
    expect(reconcileSubagentLabel(subagent, 'blessing-4', 'bb6214b9 (2026-07-16)')).toBe(
      'blessing-4',
    );
  });

  test('keeps the first stable task name when derived titles change', () => {
    expect(reconcileSubagentLabel(subagent, 'blessing-4', 'Changing title')).toBe('blessing-4');
  });
});

describe('isInternalSubagentLabel', () => {
  test('does not classify a user-provided hexadecimal-looking task name as a fallback', () => {
    expect(isInternalSubagentLabel(subagent, 'deadbeef-worker')).toBe(false);
  });
});
