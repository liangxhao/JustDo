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

  test('does not duplicate the temporary first-turn message created for the same submission', () => {
    const temporaryMessage = {
      role: 'user',
      content: 'hello',
      timestamp: 90,
      id: 'temporary-message',
    } as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([temporaryMessage], pending)).toEqual([
      temporaryMessage,
    ]);
  });

  test('reconciles a Goal command with its persisted objective without duplicating it', () => {
    const pendingGoal = {
      role: 'user',
      content: '/goal write two poems',
      timestamp: 100,
    } as GatewayMessage;
    const persistedGoal = {
      role: 'user',
      content: 'write two poems',
      timestamp: 110,
      __openclaw: { id: 'goal-message' },
    } as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([persistedGoal], pendingGoal)).toEqual([
      persistedGoal,
    ]);
  });

  test('keeps attachments pending without a shared input identity', () => {
    const pendingWithAttachment = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'attachment', attachment: { url: 'data:image/png;base64,pending' } },
      ],
      timestamp: 100,
    } as GatewayMessage;
    const persisted = {
      role: 'user',
      content: 'hello',
      timestamp: 110,
    } as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([persisted], pendingWithAttachment)).toEqual([
      pendingWithAttachment,
      persisted,
    ]);
    expect(mergePendingUserMessageForDisplay([
      { ...persisted, __openclaw: { idempotencyKey: 'image-input:user' } },
    ], {
      ...pendingWithAttachment,
      __openclaw: { idempotencyKey: 'image-input:user' },
    })).toEqual([{ ...persisted, __openclaw: { idempotencyKey: 'image-input:user' } }]);
  });

  test.each([
    { MediaPaths: ['C:\\media\\image.png'] },
    { __openclaw: { media: [{ path: 'media://inbound/image.png' }] } },
    { content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'image.png' } }] },
  ])('does not mistake media-bearing history for an unbound plain prompt: %j', media => {
    const history = { ...pending, timestamp: 90, ...media } as GatewayMessage;
    expect(mergePendingUserMessageForDisplay([history], pending)).toEqual([history, pending]);
  });

  test('compares exact input keys across wrapped and top-level native metadata', () => {
    const wrapped = {
      message: { role: 'user', content: 'native file context', idempotencyKey: 'input:user:user' },
    } as unknown as GatewayMessage;
    const local = {
      ...pending,
      __openclaw: { idempotencyKey: 'input:user:user' },
    };

    expect(mergePendingUserMessageForDisplay([wrapped], local)).toEqual([wrapped]);
    expect(mergePendingUserMessageForDisplay([wrapped], {
      ...local, __openclaw: { idempotencyKey: 'input:user' },
    })).toEqual([wrapped, { ...local, __openclaw: { idempotencyKey: 'input:user' } }]);
  });

  test('keeps a repeated prompt from a different turn', () => {
    const olderPrompt = {
      role: 'user',
      content: 'hello',
      timestamp: 100 - 60_000,
    } as GatewayMessage;

    expect(mergePendingUserMessageForDisplay([olderPrompt], pending)).toEqual([
      olderPrompt,
      pending,
    ]);
  });

  test('does not infer a match for annotation cards without a stable identity', () => {
    const pendingAnnotation = {
      ...pending,
      content: [
        { type: 'text', text: 'hello' },
        { type: 'browser_annotation', annotation: { title: 'Example' } },
      ],
    } as GatewayMessage;
    const history = [{ ...pendingAnnotation, timestamp: 90 }];

    expect(mergePendingUserMessageForDisplay(history, pendingAnnotation)).toEqual([
      ...history,
      pendingAnnotation,
    ]);
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
