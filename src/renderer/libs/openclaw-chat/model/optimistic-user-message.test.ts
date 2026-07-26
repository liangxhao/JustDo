import { describe, expect, test } from 'vitest';

import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { mergePendingUserMessageForDisplay } from './optimistic-user-message';

describe('mergePendingUserMessageForDisplay', () => {
  const pending = {
    role: 'user',
    content: 'hello',
    timestamp: 100,
  } as GatewayMessage;

  test('places a pending first-turn prompt before a response that reached history first', () => {
    const assistant = {
      role: 'assistant',
      content: 'hi',
      timestamp: 200,
    } as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([assistant], pending)).toEqual([
      pending,
      assistant,
    ]);
  });

  test('keeps a pending later-turn prompt after older history and before its response', () => {
    const history = [
      { role: 'user', content: 'older question', timestamp: 10 },
      { role: 'assistant', content: 'older answer', timestamp: 20 },
      { role: 'assistant', content: 'new answer', timestamp: 200 },
    ] as GatewayMessage[];

    expect(mergePendingUserMessageForDisplay(history, pending)).toEqual([
      history[0],
      history[1],
      pending,
      history[2],
    ]);
  });

  test('does not duplicate a pending prompt already present in history', () => {
    expect(mergePendingUserMessageForDisplay([pending], pending)).toEqual([pending]);
  });

  test('falls back to placing a first-turn prompt before an undated assistant response', () => {
    const assistant = { role: 'assistant', content: 'hi' } as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([assistant], pending)).toEqual([
      pending,
      assistant,
    ]);
  });

  test('orders against timestamped wrapped gateway messages', () => {
    const assistant = {
      message: {
        role: 'assistant',
        content: 'hi',
        timestamp: new Date(200).toISOString(),
      },
    } as unknown as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([assistant], pending)).toEqual([
      pending,
      assistant,
    ]);
  });
});
