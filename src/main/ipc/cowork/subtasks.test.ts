import { describe, expect, it, vi } from 'vitest';

import { loadCoworkSubagentDetails } from './subtasks';

describe('loadCoworkSubagentDetails', () => {
  it.each(['missing', 'empty', 'failed'] as const)(
    'preserves exact task details when usage is %s',
    async reason => {
      const subagent = {
        id: 'task-one',
        taskName: 'task-one',
        sessionKey: 'agent:main:subagent:child-1',
        label: 'Task',
        labelSource: 'label' as const,
        status: 'failed' as const,
        task: 'Complete prompt',
        error: 'Model unavailable',
      };
      const usage =
        reason === 'missing'
          ? undefined
          : reason === 'empty'
            ? vi.fn().mockResolvedValue(null)
            : vi.fn().mockRejectedValue(new Error('usage offline'));
      await expect(
        loadCoworkSubagentDetails(usage, subagent.sessionKey, {
          taskId: subagent.id,
          loadSubagent: vi.fn().mockResolvedValue(subagent),
        }),
      ).resolves.toEqual({ success: true, subagent });
    },
  );

  it('rejects a mismatched task before attempting usage enrichment', async () => {
    const usage = vi.fn();
    const result = await loadCoworkSubagentDetails(usage, 'agent:main:subagent:child-1', {
      taskId: 'task-other',
      loadSubagent: vi.fn().mockResolvedValue({ sessionKey: 'agent:main:subagent:other' }),
    });
    expect(result).toEqual({
      success: false,
      error: 'Task does not belong to the requested session',
    });
    expect(usage).not.toHaveBeenCalled();
  });

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
        totalTokens: 58,
        hasTokenUsage: true,
      },
    });
    expect(loadSessionUsage).toHaveBeenCalledWith('agent:main:subagent:child-1', undefined);
  });

  it('does not expose a partial result when Gateway usage fails', async () => {
    const loadSessionUsage = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(
      loadCoworkSubagentDetails(loadSessionUsage, 'agent:main:subagent:child-1'),
    ).resolves.toEqual({ success: false, error: 'offline' });
  });

  it('combines canonical usage with the exact task detail without loading history', async () => {
    const loadSessionUsage = vi.fn().mockResolvedValue({
      totalTokens: 12,
      messageCounts: { total: 20, user: 10, assistant: 10, toolCalls: 1 },
    });
    const loadSubagent = vi.fn().mockResolvedValue({
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:child-1',
      sessionId: 'session-one',
      label: 'Task',
      labelSource: 'label',
      status: 'running',
      task: 'Complete prompt',
      updatedAt: 123,
    });

    const result = await loadCoworkSubagentDetails(
      loadSessionUsage,
      'agent:main:subagent:child-1',
      {
        taskId: 'task-one',
        loadSubagent,
      },
    );

    expect(result).toMatchObject({
      success: true,
      subagent: { id: 'task-one', task: 'Complete prompt', sessionId: 'session-one' },
      stats: {
        messageCount: 20,
        userMessageCount: 10,
        assistantMessageCount: 10,
        totalTokens: 12,
      },
    });
    expect(loadSessionUsage).toHaveBeenCalledWith('agent:main:subagent:child-1', undefined);
  });

  it('uses the terminal task revision to reuse an exact usage snapshot', async () => {
    const loadSessionUsage = vi.fn().mockResolvedValue({ totalTokens: 12 });
    const loadSubagent = vi.fn().mockResolvedValue({
      id: 'task-one',
      taskName: 'task-one',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'Task',
      labelSource: 'label',
      status: 'done',
      updatedAt: 456,
    });

    await loadCoworkSubagentDetails(loadSessionUsage, 'agent:main:subagent:child-1', {
      taskId: 'task-one',
      loadSubagent,
    });

    expect(loadSessionUsage).toHaveBeenCalledWith('agent:main:subagent:child-1', 456);
  });

  it.each([
    ['rejects', vi.fn().mockRejectedValue(new Error('task lookup failed'))],
    ['returns no task', vi.fn().mockResolvedValue(null)],
  ])('fails closed when an exact task lookup %s', async (_label, loadSubagent) => {
    const result = await loadCoworkSubagentDetails(
      vi.fn().mockResolvedValue({ totalTokens: 1 }),
      'agent:main:subagent:child-1',
      { taskId: 'task-one', loadSubagent },
    );

    expect(result.success).toBe(false);
  });

  it('rejects an exact task request when no task loader is available', async () => {
    await expect(
      loadCoworkSubagentDetails(
        vi.fn().mockResolvedValue({ totalTokens: 1 }),
        'agent:main:subagent:child-1',
        { taskId: 'task-one' },
      ),
    ).resolves.toEqual({ success: false, error: 'Gateway task details are not available' });
  });
});
