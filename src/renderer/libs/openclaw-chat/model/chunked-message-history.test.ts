import { describe, expect, test } from 'vitest';

import { ChunkedMessageHistory } from './chunked-message-history';

function message(index: number): unknown {
  return {
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    __openclaw: { id: `message-${index}` },
  };
}

describe('ChunkedMessageHistory', () => {
  test('keeps 100,000 messages reachable without flattening pages during prepend', () => {
    const history = new ChunkedMessageHistory();
    history.reset(Array.from({ length: 250 }, (_, index) => message(99_750 + index)));

    for (let pageEnd = 99_750; pageEnd > 0; pageEnd -= 250) {
      const pageStart = Math.max(0, pageEnd - 250);
      history.prepend(
        Array.from({ length: pageEnd - pageStart }, (_, index) => message(pageStart + index)),
      );
    }

    expect(history.length).toBe(100_000);
    expect(history.chunkCount).toBe(400);
    expect(history.slice(0, 2)).toEqual([message(0), message(1)]);
    expect(history.slice(49_999, 50_002)).toEqual([
      message(49_999),
      message(50_000),
      message(50_001),
    ]);
    expect(history.slice(99_998, 100_000)).toEqual([message(99_998), message(99_999)]);
  });

  test('deduplicates durable identities across page seams', () => {
    const history = new ChunkedMessageHistory();
    history.reset([message(2), message(3)]);

    expect(history.prepend([message(0), message(1), message(2)])).toBe(2);
    expect(history.toArray()).toEqual([message(0), message(1), message(2), message(3)]);
  });

  test('replaces only the recent reconciliation chunk', () => {
    const history = new ChunkedMessageHistory();
    history.reset([message(2), message(3)]);
    history.prepend([message(0), message(1)]);

    history.replaceRecent([message(2), message(3), message(4)]);

    expect(history.toArray()).toEqual([message(0), message(1), message(2), message(3), message(4)]);
  });

  test('lets a larger recent snapshot replace identities already stored in older chunks', () => {
    const history = new ChunkedMessageHistory();
    history.reset([message(8), message(9)]);
    history.prepend([message(4), message(5), message(6), message(7)]);
    history.prepend([message(0), message(1), message(2), message(3)]);

    history.replaceRecent([
      { ...(message(2) as Record<string, unknown>), content: 'authoritative 2' },
      message(3),
      message(4),
      message(5),
      message(6),
      message(7),
      message(8),
      message(9),
      message(10),
    ]);

    expect(history.length).toBe(11);
    expect(history.toArray()).toEqual([
      message(0),
      message(1),
      { ...(message(2) as Record<string, unknown>), content: 'authoritative 2' },
      message(3),
      message(4),
      message(5),
      message(6),
      message(7),
      message(8),
      message(9),
      message(10),
    ]);
  });

  test('does not rescan older chunks when the live tail changes', () => {
    let olderIdentityReads = 0;
    const older = Array.from({ length: 10_000 }, (_, index) => ({
      role: 'assistant',
      content: `older-${index}`,
      get __openclaw() {
        olderIdentityReads += 1;
        return { id: `older-${index}` };
      },
    }));
    const history = new ChunkedMessageHistory();
    history.reset([message(10_000)]);
    history.prepend(older);
    olderIdentityReads = 0;

    history.replaceRecent([message(10_000), message(10_001)]);

    expect(olderIdentityReads).toBe(0);
    expect(history.length).toBe(10_002);
  });
});
