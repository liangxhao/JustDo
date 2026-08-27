import { describe, expect, it, vi } from 'vitest';

import { loadCoworkSubagentDetails } from './subtasks';

describe('loadCoworkSubagentDetails', () => {
  it('uses complete raw-transcript usage for every subagent model request', async () => {
    const loadSessionUsage = vi.fn().mockResolvedValue({
      input: 40,
      output: 4,
      cacheRead: 8,
      cacheWrite: 3,
      totalTokens: 58,
      messageCounts: { total: 3, user: 1, assistant: 2, toolCalls: 1 },
      modelUsage: [{ provider: 'openai', model: 'gpt-5', count: 2 }],
    });

    const result = await loadCoworkSubagentDetails(loadSessionUsage, 'agent:main:subagent:child-1');

    expect(result).toMatchObject({
      success: true,
      stats: {
        tokenUsage: { input: 40, output: 4, cacheRead: 8, cacheWrite: 3 },
        totalTokens: 55,
        hasTokenUsage: true,
      },
    });
    expect(loadSessionUsage).toHaveBeenCalledWith('agent:main:subagent:child-1');
  });

  it('does not expose a partial result when Gateway usage fails', async () => {
    const loadSessionUsage = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(
      loadCoworkSubagentDetails(loadSessionUsage, 'agent:main:subagent:child-1'),
    ).resolves.toEqual({ success: false, error: 'offline' });
  });
});
