import { describe, expect, test } from 'vitest';

import { markOptimisticHistoryTail } from './optimistic-history-tail';
import { applySessionMessagePayload } from './session-message-apply';

const options = {
  activeRunId: null,
  runActive: false,
  isRecentTerminalRun: () => false,
};

function message(role: string, content: string, id: string, seq: number, runId?: string) {
  return {
    role,
    content,
    __openclaw: { id, seq, ...(runId ? { runId } : {}) },
  };
}

describe('applySessionMessagePayload', () => {
  test('canonicalizes envelope identity and inserts a durable user row by sequence', () => {
    const first = message('user', 'first', 'message-1', 1);
    const third = message('user', 'third', 'message-3', 3);

    const result = applySessionMessagePayload(
      [first, third],
      {
        messageId: 'message-2',
        messageSeq: 2,
        message: { role: 'user', content: 'second' },
      },
      options,
    );

    expect(result.kind).toBe('applied');
    expect(result.messages).toEqual([
      first,
      {
        role: 'user',
        content: 'second',
        __openclaw: { id: 'message-2', seq: 2 },
      },
      third,
    ]);
  });

  test('replaces a replayed identity in place without duplicating the row', () => {
    const result = applySessionMessagePayload(
      [message('user', 'old', 'message-1', 1)],
      {
        messageId: 'message-1',
        messageSeq: 1,
        message: { role: 'user', content: 'authoritative' },
      },
      options,
    );

    expect(result.kind).toBe('applied');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ content: 'authoritative' });
  });

  test('does not collapse equal text with different durable IDs', () => {
    const result = applySessionMessagePayload(
      [message('user', 'same', 'message-1', 1)],
      {
        messageId: 'message-2',
        messageSeq: 2,
        message: { role: 'user', content: 'same' },
      },
      options,
    );

    expect(result.messages).toHaveLength(2);
  });

  test('inserts a delayed previous-run assistant before a newer active prompt', () => {
    const first = message('user', 'old prompt', 'message-1', 1, 'run-old');
    const current = message('user', 'current prompt', 'message-3', 3, 'run-current');

    const result = applySessionMessagePayload(
      [first, current],
      {
        runId: 'run-old',
        message: message('assistant', 'old reply', 'message-2', 2, 'run-old'),
      },
      {
        activeRunId: 'run-current',
        runActive: true,
        isRecentTerminalRun: () => false,
      },
    );

    expect(result.kind).toBe('applied');
    expect(result.messages.map(item => (item as { content: string }).content)).toEqual([
      'old prompt',
      'old reply',
      'current prompt',
    ]);
  });

  test('admits only producer-owned current-run assistant rows', () => {
    const owned = applySessionMessagePayload(
      [],
      {
        runId: 'run-current',
        message: message('assistant', 'owned', 'message-2', 2, 'run-current'),
      },
      {
        activeRunId: 'run-current',
        runActive: true,
        isRecentTerminalRun: () => false,
      },
    );
    const ambiguous = applySessionMessagePayload(
      [],
      {
        message: message('assistant', 'ambiguous', 'message-2', 2, 'run-current'),
      },
      {
        activeRunId: 'run-current',
        runActive: true,
        isRecentTerminalRun: () => false,
      },
    );

    expect(owned.kind).toBe('applied');
    expect(ambiguous).toMatchObject({ kind: 'fallback', reason: 'unowned-assistant' });
  });

  test('adopts an optimistic user by send identity and preserves local attachments', () => {
    const optimistic = markOptimisticHistoryTail({
      role: 'user',
      content: [
        { type: 'text', text: 'prompt' },
        { type: 'image', source: { type: 'base64', data: 'local-image' } },
      ],
      __openclaw: { idempotencyKey: 'run-provisional', runId: 'run-provisional' },
    });

    const result = applySessionMessagePayload(
      [optimistic],
      {
        messageId: 'message-1',
        messageSeq: 1,
        runId: 'run-acknowledged',
        message: {
          role: 'user',
          content: 'prompt',
          __openclaw: { idempotencyKey: 'run-provisional:user' },
        },
      },
      {
        activeRunId: 'run-acknowledged',
        runActive: true,
        isRecentTerminalRun: () => false,
      },
    );

    expect(result.kind).toBe('applied');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      content: (optimistic as { content: unknown }).content,
      __openclaw: { id: 'message-1', seq: 1 },
    });
  });

  test('requires a message-owned sequence for incomplete imported provenance', () => {
    const envelopeOnly = applySessionMessagePayload(
      [],
      {
        messageSeq: 2,
        message: {
          role: 'assistant',
          content: 'imported',
          __openclaw: { importedFrom: 'cli', runId: 'run-old' },
        },
      },
      {
        activeRunId: 'run-current',
        runActive: true,
        isRecentTerminalRun: () => false,
      },
    );
    const persisted = applySessionMessagePayload(
      [],
      {
        message: {
          role: 'assistant',
          content: 'imported',
          __openclaw: { importedFrom: 'cli', runId: 'run-old', seq: 2 },
        },
      },
      {
        activeRunId: 'run-current',
        runActive: true,
        isRecentTerminalRun: () => false,
      },
    );

    expect(envelopeOnly).toMatchObject({ kind: 'fallback', reason: 'partial-import' });
    expect(persisted.kind).toBe('applied');
  });
});
