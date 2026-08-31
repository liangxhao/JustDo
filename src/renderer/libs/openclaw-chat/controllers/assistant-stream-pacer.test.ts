import { describe, expect, test } from 'vitest';

import { AssistantStreamPacer } from './assistant-stream-pacer';

describe('AssistantStreamPacer', () => {
  test('replays cumulative provider snapshots one frame at a time', () => {
    const pacer = new AssistantStreamPacer();

    pacer.observe([{ id: 'content-1', text: '你' }]);
    pacer.observe([{ id: 'content-1', text: '你好' }]);
    pacer.observe([{ id: 'content-1', text: '你好，世界' }]);

    expect(pacer.displayText('content-1', '你好，世界')).toBe('');
    expect(pacer.isPending('content-1')).toBe(true);
    expect(pacer.advance()).toBe(true);
    expect(pacer.displayText('content-1', '你好，世界')).toBe('你');
    expect(pacer.advance()).toBe(true);
    expect(pacer.displayText('content-1', '你好，世界')).toBe('你好');
    expect(pacer.advance()).toBe(false);
    expect(pacer.displayText('content-1', '你好，世界')).toBe('你好，世界');
    expect(pacer.isPending('content-1')).toBe(false);
  });

  test('seeds an already visible stream without replaying its history', () => {
    const pacer = new AssistantStreamPacer();

    pacer.seed([{ id: 'content-1', text: 'already visible' }]);
    pacer.observe([{ id: 'content-1', text: 'already visible now' }]);

    expect(pacer.displayText('content-1', 'already visible now')).toBe('already visible');
    expect(pacer.advance()).toBe(false);
    expect(pacer.displayText('content-1', 'already visible now')).toBe('already visible now');
  });

  test('splits an oversized provider snapshot into bounded visual segments', () => {
    const pacer = new AssistantStreamPacer();
    pacer.observe([{ id: 'content-1', text: '一二三四五六七八九十' }]);

    expect(pacer.advance()).toBe(true);
    expect(pacer.displayText('content-1', '一二三四五六七八九十')).toBe('一二三四五六');
    expect(pacer.advance()).toBe(false);
    expect(pacer.displayText('content-1', '一二三四五六七八九十')).toBe('一二三四五六七八九十');
  });

  test('bounds catch-up latency when a provider delivers a large burst', () => {
    const pacer = new AssistantStreamPacer();
    for (let index = 1; index <= 91; index += 1) {
      pacer.observe([{ id: 'content-1', text: 'x'.repeat(index) }]);
    }

    expect(pacer.advance()).toBe(true);
    expect(pacer.displayText('content-1', 'x'.repeat(91))).toBe('xxx');

    for (let frame = 1; frame < AssistantStreamPacer.MAX_CATCH_UP_FRAMES; frame += 1) {
      pacer.advance();
    }
    expect(pacer.hasPending()).toBe(false);
    expect(pacer.displayText('content-1', 'x'.repeat(91))).toBe('x'.repeat(91));
  });

  test('applies authoritative revisions immediately and drops stale queued text', () => {
    const pacer = new AssistantStreamPacer();
    pacer.observe([{ id: 'content-1', text: 'draft' }]);
    pacer.observe([{ id: 'content-1', text: 'draft that will be rejected' }]);

    pacer.observe([{ id: 'content-1', text: 'revised' }]);

    expect(pacer.hasPending()).toBe(false);
    expect(pacer.displayText('content-1', 'revised')).toBe('revised');
  });

  test('flushes completed tool-bound content and forgets rolled-back items', () => {
    const pacer = new AssistantStreamPacer();
    pacer.observe([{ id: 'content-1', text: 'before tool' }]);
    pacer.observe([{ id: 'content-1', text: 'before tool now', flush: true }]);

    expect(pacer.displayText('content-1', 'before tool now')).toBe('before tool now');
    expect(pacer.hasPending()).toBe(false);

    pacer.observe([]);
    expect(pacer.displayText('content-1', 'fallback')).toBe('fallback');
  });

  test('caps snapshot boundary objects while retaining the complete canonical suffix', () => {
    const pacer = new AssistantStreamPacer();
    const count = AssistantStreamPacer.MAX_PENDING_SNAPSHOT_BOUNDARIES + 20;
    for (let index = 1; index <= count; index += 1) {
      pacer.observe([{ id: 'content-1', text: 'x'.repeat(index) }]);
    }

    while (pacer.advance()) {
      // Drain the bounded presentation queue.
    }
    expect(pacer.displayText('content-1', 'x'.repeat(count))).toBe('x'.repeat(count));
  });

  test('keeps every frame bounded for a very large single snapshot', () => {
    const pacer = new AssistantStreamPacer();
    const canonical = 'x'.repeat(5_000);
    pacer.observe([{ id: 'content-1', text: canonical }]);

    let previousLength = 0;
    let frames = 0;
    while (pacer.hasPending() && frames < 1_000) {
      pacer.advance();
      const nextLength = pacer.displayText('content-1', canonical).length;
      expect(nextLength - previousLength).toBeLessThanOrEqual(
        AssistantStreamPacer.MAX_GRAPHEMES_PER_FRAME,
      );
      previousLength = nextLength;
      frames += 1;
    }

    expect(frames).toBeGreaterThan(AssistantStreamPacer.MAX_CATCH_UP_FRAMES);
    expect(previousLength).toBe(canonical.length);
  });

  test('can converge immediately when animation frames are unavailable', () => {
    const pacer = new AssistantStreamPacer();
    pacer.observe([{ id: 'content-1', text: 'fallback text' }]);

    pacer.flushPending();

    expect(pacer.hasPending()).toBe(false);
    expect(pacer.displayText('content-1', 'fallback text')).toBe('fallback text');
  });
});
