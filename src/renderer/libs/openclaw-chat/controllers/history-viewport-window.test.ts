import { describe, expect, test } from 'vitest';

import { HistoryViewportWindow } from './history-viewport-window';

const keys = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, index) => `row-${start + index}`);

describe('HistoryViewportWindow', () => {
  test('starts at the tail of 100,000 rows and queries scrolling without scanning source keys', () => {
    let sourceReads = 0;
    const source = new Proxy(keys(0, 100_000), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) sourceReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    window.setRows(source, 'session');
    sourceReads = 0;

    expect(window.select(null, 600)).toEqual({
      start: 99_940,
      end: 100_000,
      before: 1_998_800,
      after: 0,
      totalHeight: 2_000_000,
    });
    for (let top = 0; top < 2_000_000; top += 3_997) {
      const range = window.select(top, 600);
      expect(range.end - range.start).toBeLessThanOrEqual(250);
      expect(range.before).toBeLessThanOrEqual(top);
      expect(window.offsetAt(range.end)).toBeGreaterThanOrEqual(
        Math.min(2_000_000, top + 600),
      );
    }
    expect(sourceReads).toBe(0);
  });

  test('keeps exact measured identities and reading offsets when older rows are prepended', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    window.setRows(keys(100, 150), 'session');
    window.measure([
      { key: 'row-110', height: 160 },
      { key: 'row-130', height: 40 },
    ]);
    const previousAnchor = window.offsetAt(20);
    const previousTotal = window.totalHeight;

    window.setRows(keys(0, 150), 'session');

    expect(window.offsetAt(120) - previousAnchor).toBe(2_000);
    expect(window.totalHeight - previousTotal).toBe(2_000);
    expect(window.offsetAt(111) - window.offsetAt(110)).toBe(160);
    expect(window.offsetAt(131) - window.offsetAt(130)).toBe(40);
    const range = window.select(window.offsetAt(120), 100);
    expect(range.start).toBeLessThanOrEqual(120);
    expect(range.end).toBeGreaterThan(120);
  });

  test('retains the row being read inside a very tall message in both directions', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    window.setRows(keys(0, 3), 'session');
    window.measure([{ key: 'row-1', height: 100_000 }]);

    const lower = window.select(75_000, 600);
    const upper = window.select(25_000, 600);

    expect(lower).toEqual(upper);
    expect(lower).toEqual({
      start: 1,
      end: 2,
      before: 20,
      after: 20,
      totalHeight: 100_040,
    });
    expect(window.ensureIndex(1, 600).start).toBeLessThanOrEqual(1);
    expect(window.ensureIndex(1, 600).end).toBeGreaterThan(1);
  });

  test('limits overscan while preserving every actually visible row in a huge viewport', () => {
    const window = new HistoryViewportWindow({
      estimatedRowHeight: 1,
      overscanViewports: 5,
    });
    window.setRows(keys(0, 10_000), 'session');

    const normal = window.select(5_000, 100);
    expect(normal.end - normal.start).toBe(250);
    expect(normal.start).toBeLessThanOrEqual(5_000);
    expect(normal.end).toBeGreaterThanOrEqual(5_100);
    const huge = window.select(5_000, 1_000);
    expect(huge).toEqual({
      start: 5_000,
      end: 6_000,
      before: 5_000,
      after: 4_000,
      totalHeight: 10_000,
    });
  });

  test('uses the same geometry when reversing direction and updating measured heights', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    window.setRows(keys(0, 1_000), 'session');
    const before = window.select(5_000, 400);
    window.select(15_000, 400);
    expect(window.select(5_000, 400)).toEqual(before);

    window.measure([{ key: 'row-10', height: 320 }]);
    const after = window.select(5_300, 400);
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);
    expect(after.before - before.before).toBe(300);
    expect(after.after).toBe(before.after);
    expect(after.totalHeight - before.totalHeight).toBe(300);
  });

  test('materializes search targets outside the current viewport, including the first and last row', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    window.setRows(keys(0, 100_000), 'session');

    for (const index of [0, 50_000, 99_999]) {
      const range = window.ensureIndex(index, 600);
      expect(range.start).toBeLessThanOrEqual(index);
      expect(range.end).toBeGreaterThan(index);
      expect(range.end - range.start).toBeLessThanOrEqual(250);
    }
    expect(window.ensureIndex(-1, 600).start).toBe(0);
    expect(window.ensureIndex(100_000, 600).end).toBe(100_000);
  });

  test('handles exact row boundaries and fractional measured heights without including the next row', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20, overscanViewports: 0 });
    window.setRows(keys(0, 5), 'session');
    window.measure([{ key: 'row-0', height: 10.5 }]);

    expect(window.select(10.5, 40)).toEqual({
      start: 1,
      end: 3,
      before: 10.5,
      after: 40,
      totalHeight: 90.5,
    });
    expect(window.select(10.5, 0).start).toBe(1);
    expect(window.select(10.5, 0).end).toBe(2);
  });

  test('does not adopt invalid, unknown or unlaid-out measurements', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    window.setRows(keys(0, 2), 'session');

    expect(window.measure([
      { key: 'row-0', height: 0 },
      { key: 'row-0', height: -20 },
      { key: 'row-0', height: Number.NaN },
      { key: 'row-0', height: Number.POSITIVE_INFINITY },
      { key: 'missing', height: 100 },
    ])).toBe(false);
    expect(window.totalHeight).toBe(40);
    expect(window.measure([{ key: 'row-0', height: 20 }])).toBe(false);
  });

  test('clears measured heights on native scope changes and supports empty or cleared history', () => {
    const window = new HistoryViewportWindow({ estimatedRowHeight: 20 });
    const source = keys(0, 2);
    expect(window.setRows(source, 'session-1')).toBe(true);
    window.measure([{ key: 'row-0', height: 200 }]);
    expect(window.setRows(source, 'session-1')).toBe(false);
    expect(window.setRows([...source], 'session-1')).toBe(false);
    expect(window.totalHeight).toBe(220);

    expect(window.setRows(source, 'session-2')).toBe(true);
    expect(window.totalHeight).toBe(40);
    window.setRows([], 'session-2');
    expect(window.select(null, 600)).toEqual({
      start: 0, end: 0, before: 0, after: 0, totalHeight: 0,
    });
    expect(window.ensureIndex(12, 600)).toEqual(window.select(null, 600));
    window.setRows(source, 'session-2');
    window.measure([{ key: 'row-0', height: 200 }]);
    window.clear();
    expect(window.length).toBe(0);
    expect(window.totalHeight).toBe(0);
    window.setRows(source, 'session-2');
    expect(window.totalHeight).toBe(40);
  });
});
