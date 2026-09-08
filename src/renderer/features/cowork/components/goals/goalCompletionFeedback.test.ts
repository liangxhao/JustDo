import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { describe, expect, it, vi } from 'vitest';

import {
  shouldDiscardGoalCompletionFeedback,
  submitGoalCompletionFeedback,
} from './goalCompletionFeedback';

describe('submitGoalCompletionFeedback', () => {
  it('discards persisted feedback whenever canonical metadata belongs to another goal', () => {
    expect(shouldDiscardGoalCompletionFeedback('goal-1', 'goal-2')).toBe(true);
    expect(shouldDiscardGoalCompletionFeedback('goal-1', 'goal-1')).toBe(false);
    expect(shouldDiscardGoalCompletionFeedback('goal-1', null)).toBe(false);
  });

  it('prepares the old goal before sending one combined goal-and-feedback message', async () => {
    const order: string[] = [];
    const onPrepared = vi.fn(() => order.push('prepared'));
    const restart = vi.fn(async () => {
      order.push('prepare');
      return { success: true, objective: 'Ship the release' };
    });
    const send = vi.fn(async () => {
      order.push('send');
      return true;
    });

    await expect(
      submitGoalCompletionFeedback({
        completedGoalId: 'goal-1',
        restart,
        onPrepared,
        feedback: 'Also add release notes',
        send,
      }),
    ).resolves.toBe('sent');

    expect(order).toEqual(['prepare', 'prepared', 'send']);
    expect(send).toHaveBeenCalledWith(
      buildGoalFollowUpPrompt('Ship the release', 'Also add release notes'),
    );
  });

  it('does not send feedback when preparation fails', async () => {
    const send = vi.fn();

    await expect(
      submitGoalCompletionFeedback({
        completedGoalId: 'goal-1',
        restart: vi.fn().mockResolvedValue({ success: false }),
        onPrepared: vi.fn(),
        feedback: 'Add tests',
        send,
      }),
    ).resolves.toBe('restart_failed');

    expect(send).not.toHaveBeenCalled();
  });

  it('idempotently prepares an already-cleared goal when retrying a failed message send', async () => {
    const restart = vi.fn().mockResolvedValue({
      success: true,
      objective: 'Ship the release',
    });

    await expect(
      submitGoalCompletionFeedback({
        completedGoalId: 'goal-1',
        preparedObjective: 'Ship the release',
        restart,
        onPrepared: vi.fn(),
        feedback: 'Add tests',
        send: vi.fn().mockResolvedValue(false),
      }),
    ).resolves.toBe('send_failed');

    expect(restart).toHaveBeenCalledWith('goal-1', 'Ship the release');
  });

  it('turns a rejected message send into a recoverable send failure', async () => {
    await expect(
      submitGoalCompletionFeedback({
        completedGoalId: 'goal-1',
        preparedObjective: 'Ship the release',
        restart: vi.fn().mockResolvedValue({
          success: true,
          objective: 'Ship the release',
        }),
        onPrepared: vi.fn(),
        feedback: 'Add tests',
        send: vi.fn().mockRejectedValue(new Error('transport closed')),
      }),
    ).resolves.toBe('send_failed');
  });

  it('does not send after the submission context changes', async () => {
    const send = vi.fn();

    await expect(
      submitGoalCompletionFeedback({
        completedGoalId: 'goal-1',
        preparedObjective: 'Ship the release',
        restart: vi.fn().mockResolvedValue({
          success: true,
          objective: 'Ship the release',
        }),
        onPrepared: vi.fn(),
        canSend: () => false,
        feedback: 'Add tests',
        send,
      }),
    ).resolves.toBe('context_changed');

    expect(send).not.toHaveBeenCalled();
  });
});
