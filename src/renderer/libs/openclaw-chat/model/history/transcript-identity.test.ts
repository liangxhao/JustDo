import { describe, expect, test } from 'vitest';

import { isEntryAfterLatestPlanImplementationReset } from './transcript-identity';

describe('Plan implementation transcript boundary', () => {
  const messages = [
    { role: 'user', __openclaw: { id: 'planning-user' } },
    {
      role: 'system',
      __openclaw: { id: 'implementation-reset', kind: 'reset', planImplementation: true },
    },
    { role: 'user', __openclaw: { id: 'implementation-user' } },
  ];

  test('rejects entries before the latest implementation reset', () => {
    expect(isEntryAfterLatestPlanImplementationReset(messages, 'planning-user')).toBe(false);
  });

  test('allows entries after the latest implementation reset', () => {
    expect(isEntryAfterLatestPlanImplementationReset(messages, 'implementation-user')).toBe(true);
  });

  test('allows entries when no implementation reset exists', () => {
    expect(
      isEntryAfterLatestPlanImplementationReset(
        [{ role: 'user', __openclaw: { id: 'ordinary-user' } }],
        'ordinary-user',
      ),
    ).toBe(true);
  });

  test('infers the implementation boundary from a persisted PresentPlan followed by reset', () => {
    const inferredBoundaryMessages = [
      { role: 'user', __openclaw: { id: 'planning-user' } },
      {
        role: 'assistant',
        content: [{ type: 'toolcall', name: 'PresentPlan', input: { plan: 'Ship it' } }],
        __openclaw: { id: 'planning-assistant' },
      },
      { role: 'system', __openclaw: { id: 'native-reset', kind: 'reset' } },
      { role: 'user', __openclaw: { id: 'implementation-user' } },
    ];

    expect(
      isEntryAfterLatestPlanImplementationReset(inferredBoundaryMessages, 'planning-user'),
    ).toBe(false);
    expect(
      isEntryAfterLatestPlanImplementationReset(inferredBoundaryMessages, 'implementation-user'),
    ).toBe(true);
  });
});
