import { describe, expect, test } from 'vitest';

import type { MessageGroup } from '../types';
import {
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
} from './grouped-render';

function createGroup(role: string): MessageGroup {
  return {
    kind: 'group',
    key: `${role}-group`,
    role,
    messages: [{ key: `${role}-msg`, message: { role, content: 'hello', timestamp: 1 } }],
    timestamp: 1,
    isStreaming: false,
  };
}

describe('shouldRenderGroupFooter', () => {
  test('hides assistant footer when another assistant group follows', () => {
    expect(shouldRenderGroupFooterByNextItem(createGroup('assistant'), createGroup('assistant'))).toBe(
      false,
    );
  });

  test('hides assistant footer while streaming continues', () => {
    expect(
      shouldRenderGroupFooterByNextItem(createGroup('assistant'), {
        kind: 'stream',
        key: 'stream-1',
        text: 'loading',
        startedAt: 1,
        isStreaming: true,
      }),
    ).toBe(false);
  });

  test('shows assistant footer when the next item is a different role', () => {
    expect(shouldRenderGroupFooterByNextItem(createGroup('assistant'), createGroup('user'))).toBe(
      true,
    );
  });

  test('keeps user footers visible unless another user group follows', () => {
    expect(shouldRenderGroupFooterByNextItem(createGroup('user'), createGroup('assistant'))).toBe(
      true,
    );
  });
});

describe('shouldRenderGroupAvatarByPrevItem', () => {
  test('hides avatar when the previous visible group has the same role', () => {
    expect(
      shouldRenderGroupAvatarByPrevItem(createGroup('assistant'), createGroup('assistant')),
    ).toBe(false);
  });

  test('hides assistant avatar when a stream is continuing the same turn', () => {
    expect(
      shouldRenderGroupAvatarByPrevItem(createGroup('assistant'), {
        kind: 'stream',
        key: 'stream-1',
        text: 'loading',
        startedAt: 1,
        isStreaming: true,
      }),
    ).toBe(false);
  });

  test('shows avatar when the previous visible group is a different role', () => {
    expect(shouldRenderGroupAvatarByPrevItem(createGroup('assistant'), createGroup('user'))).toBe(
      true,
    );
  });
});
