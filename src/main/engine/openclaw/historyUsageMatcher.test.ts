import { describe, expect, it } from 'vitest';

import { matchAssistantUsageByOccurrence } from './historyUsageMatcher';

describe('matchAssistantUsageByOccurrence', () => {
  it('matches repeated assistant text one-to-one in occurrence order', () => {
    const matches = matchAssistantUsageByOccurrence(
      [
        { text: 'Done', usage: { input: 10, output: 1 } },
        { text: 'Done', usage: { input: 20, output: 2 } },
      ],
      [
        { id: 'first', text: 'Done', hasUsage: false },
        { id: 'second', text: 'Done', hasUsage: false },
      ],
    );

    expect(matches).toEqual([
      { id: 'first', usage: { input: 10, output: 1 } },
      { id: 'second', usage: { input: 20, output: 2 } },
    ]);
  });

  it('consumes the history entry for a local message that already has usage', () => {
    const matches = matchAssistantUsageByOccurrence(
      [
        { text: 'Done', usage: { input: 10 } },
        { text: 'Done', usage: { input: 20 } },
      ],
      [
        { id: 'existing', text: 'Done', hasUsage: true },
        { id: 'missing', text: 'Done', hasUsage: false },
      ],
    );

    expect(matches).toEqual([{ id: 'missing', usage: { input: 20 } }]);
  });

  it('does not reuse one history entry for duplicate local rows', () => {
    const matches = matchAssistantUsageByOccurrence(
      [{ text: 'Done', usage: { input: 10 } }],
      [
        { id: 'first', text: 'Done', hasUsage: false },
        { id: 'duplicate', text: 'Done', hasUsage: false },
      ],
    );

    expect(matches).toEqual([{ id: 'first', usage: { input: 10 } }]);
  });

  it('consumes an occurrence even when that history message has no usage', () => {
    const matches = matchAssistantUsageByOccurrence(
      [
        { text: 'Done' },
        { text: 'Done', usage: { input: 20 } },
      ],
      [
        { id: 'first', text: 'Done', hasUsage: false },
        { id: 'second', text: 'Done', hasUsage: false },
      ],
    );

    expect(matches).toEqual([{ id: 'second', usage: { input: 20 } }]);
  });
});
