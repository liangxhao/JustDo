import { describe, expect, test } from 'vitest';

import { isInternalManagedSubagentHandoffError } from './internalRunError';

describe('isInternalManagedSubagentHandoffError', () => {
  test.each([
    'Managed subagent terminal handoff could not be persisted.',
    '  Managed subagent terminal handoff could not be persisted.  ',
    'Error: Managed subagent terminal handoff could not be persisted.',
  ])('recognizes the managed handoff persistence error: %s', value => {
    expect(isInternalManagedSubagentHandoffError(value)).toBe(true);
  });

  test.each([
    undefined,
    '',
    'Managed subagent state disappeared during implicit join.',
    'ordinary provider error',
  ])('keeps unrelated failures visible: %s', value => {
    expect(isInternalManagedSubagentHandoffError(value)).toBe(false);
  });
});
