import { describe, expect, test, vi } from 'vitest';

import type { CoworkSession } from '../../data/coworkStore';
import { HistoryReconciler } from './historyReconciler';

describe('HistoryReconciler assistant models', () => {
  test('patches the local assistant cache with the actual gateway model', async () => {
    const session = {
      id: 'session-1',
      messages: [
        {
          id: 'assistant-1',
          type: 'assistant',
          content: 'Final answer',
          timestamp: 1,
          metadata: { isFinal: true },
        },
      ],
    } as CoworkSession;
    const updateMessage = vi.fn();
    const emit = vi.fn();
    const reconciler = new HistoryReconciler({
      getSession: () => session,
      addMessage: vi.fn(),
      updateMessage,
      deleteMessage: vi.fn(),
      getGatewayClient: () => ({
        request: vi.fn().mockResolvedValue({
          messages: [
            {
              role: 'assistant',
              provider: 'anthropic',
              model: 'claude-sonnet-4',
              content: 'Final answer',
            },
          ],
        }),
      }),
      getGatewayHistoryCount: () => 0,
      setGatewayHistoryCount: vi.fn(),
      hasGatewayHistoryCount: () => true,
      setChannelSyncCursor: vi.fn(),
      emit,
      isCurrentTurnToken: () => true,
      resolveAssistantSegmentText: (_turn, text) => text,
      reuseFinalAssistantMessage: () => null,
      isChannelSessionKey: () => false,
      isReCreatedChannelSession: () => false,
      syncChannelUserMessages: vi.fn(),
      getFullHistorySyncLimit: () => 100,
    });

    await reconciler.reconcileWithHistory(
      'session-1',
      'agent:main:justdo:session-1',
    );

    expect(updateMessage).toHaveBeenCalledWith('session-1', 'assistant-1', {
      metadata: { isFinal: true, modelName: 'anthropic/claude-sonnet-4' },
      modelName: 'anthropic/claude-sonnet-4',
    });
    expect(emit).toHaveBeenCalledWith(
      'messageMetadataUpdate',
      'session-1',
      'assistant-1',
      { isFinal: true, modelName: 'anthropic/claude-sonnet-4' },
    );
  });

  test('matches a truncated repeated reply to the latest local occurrence', async () => {
    const session = {
      id: 'session-1',
      messages: [
        { id: 'old', type: 'assistant', content: 'Done', timestamp: 1, metadata: {} },
        { id: 'new', type: 'assistant', content: 'Done', timestamp: 2, metadata: {} },
      ],
    } as CoworkSession;
    const updateMessage = vi.fn();
    const reconciler = new HistoryReconciler({
      getSession: () => session,
      addMessage: vi.fn(),
      updateMessage,
      deleteMessage: vi.fn(),
      getGatewayClient: () => ({
        request: vi.fn().mockResolvedValue({
          messages: [
            {
              role: 'assistant',
              provider: 'openai',
              model: 'gpt-5',
              content: 'Done',
            },
          ],
        }),
      }),
      getGatewayHistoryCount: () => 0,
      setGatewayHistoryCount: vi.fn(),
      hasGatewayHistoryCount: () => true,
      setChannelSyncCursor: vi.fn(),
      emit: vi.fn(),
      isCurrentTurnToken: () => true,
      resolveAssistantSegmentText: (_turn, text) => text,
      reuseFinalAssistantMessage: () => null,
      isChannelSessionKey: () => false,
      isReCreatedChannelSession: () => false,
      syncChannelUserMessages: vi.fn(),
      getFullHistorySyncLimit: () => 100,
    });

    await reconciler.reconcileWithHistory('session-1', 'agent:main:justdo:session-1');

    expect(updateMessage).toHaveBeenCalledWith(
      'session-1',
      'new',
      expect.objectContaining({ modelName: 'openai/gpt-5' }),
    );
    expect(updateMessage).not.toHaveBeenCalledWith('session-1', 'old', expect.anything());
  });
});
