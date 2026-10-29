import { describe, expect, test } from 'vitest';

import type { ThinkingItem, ToolItem } from '../chat-transcript-state';
import { HistoryProcessIdentity } from './history-process-identity';
import type { PersistedTimelineItem } from './project-history-timeline';
import type { ProcessSummaryTimelineItem } from './project-turn-items';

function thinking(id: string): ThinkingItem {
  return {
    id, runId: 'same-run', firstSeq: 1, lastSeq: 1,
    startedAt: 1, updatedAt: 2, type: 'thinking', status: 'completed', text: 'Same text',
  };
}

function tool(id: string): ToolItem {
  return {
    id, runId: 'same-run', firstSeq: 1, lastSeq: 1,
    startedAt: 1, updatedAt: 2, type: 'tool', status: 'completed', toolCallId: id, name: 'read', input: {},
  };
}

function summary(key: string, ...items: Array<ThinkingItem | ToolItem>): ProcessSummaryTimelineItem {
  return {
    kind: 'process-summary', key, runId: 'same-run', items,
    thinkingCount: items.filter(item => item.type === 'thinking').length,
    toolCount: items.filter(item => item.type === 'tool').length,
    errorCount: 0, interruptedCount: 0,
  };
}

function message(key: string): PersistedTimelineItem {
  return { kind: 'history-message', key, message: { role: 'assistant', content: 'Answer' } };
}

describe('HistoryProcessIdentity', () => {
  test('retains Thinking and Tool shell keys when older native items reveal a new prefix', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([
      summary('history-process:recent', thinking('recent-thinking'), tool('recent-tool')),
    ], 'session');
    const source = summary(
      'history-process:older', thinking('older-thinking'), tool('older-tool'),
      thinking('recent-thinking'), tool('recent-tool'),
    );

    const result = identity.reconcile([source], 'session');

    expect(result[0]).toEqual({ ...source, key: 'history-process:recent' });
    expect((result[0] as ProcessSummaryTimelineItem).items).toBe(source.items);
    expect(source.key).toBe('history-process:older');
  });

  test('does not alias distinct groups sharing the same run, tool name or text', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([summary('old-shell', thinking('old'), tool('old-tool'))], 'session');
    const first = summary('new-shell-1', thinking('new-1'), tool('new-tool-1'));
    const second = summary('new-shell-2', thinking('new-2'), tool('new-tool-2'));
    const source = [first, message('answer'), second];

    expect(identity.reconcile(source, 'session')).toBe(source);
  });

  test('does not equate a Thinking and Tool that happen to have the same native ID', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([summary('thinking-shell', thinking('shared-id'))], 'session');
    const source = [summary('tool-shell', tool('shared-id'))];

    expect(identity.reconcile(source, 'session')).toBe(source);
  });

  test('assigns a split shell to its retained tail without duplicate keys', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([
      summary('history-process:first', thinking('first'), thinking('middle'), tool('last')),
    ], 'session');
    const split = identity.reconcile([
      summary('history-process:first', thinking('first')),
      message('boundary'),
      summary('history-process:middle', thinking('middle'), tool('last')),
    ], 'session');

    expect(split[2].key).toBe('history-process:first');
    expect(split[0].key).not.toBe(split[2].key);
    expect(new Set(split.map(item => item.key)).size).toBe(split.length);
    const returning = identity.reconcile([
      summary('history-process:first', thinking('first'), thinking('middle'), tool('last')),
    ], 'session');
    expect(returning[0].key).toBe('history-process:first');
  });

  test('merges groups into the latest retained shell deterministically', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([
      summary('older-shell', thinking('older')),
      message('boundary'),
      summary('tail-shell', tool('tail')),
    ], 'session');

    const merged = identity.reconcile([
      summary('new-source-key', thinking('new'), thinking('older'), tool('tail')),
    ], 'session');

    expect(merged[0].key).toBe('tail-shell');
  });

  test('keeps ordinary rows unchanged and avoids collisions with their keys', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([summary('retained-key', tool('retained-tool'))], 'session');
    const ordinary = message('retained-key');
    const source = summary('new-source-key', tool('retained-tool'));

    const result = identity.reconcile([source, ordinary], 'session');

    expect(result[1]).toBe(ordinary);
    expect(result[0]).toBe(source);
    expect(new Set(result.map(item => item.key)).size).toBe(2);
  });

  test('ignores process identity in other timeline kinds', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([{
      kind: 'live-process', key: 'live-key', item: thinking('retained'),
    }], 'session');
    const summarySource = [summary('summary-key', thinking('retained'))];

    expect(identity.reconcile(summarySource, 'session')).toBe(summarySource);
    const ordinary: PersistedTimelineItem = {
      kind: 'live-process', key: 'new-live-key', item: thinking('retained'),
    };
    expect(identity.reconcile([ordinary], 'session')[0]).toBe(ordinary);
  });

  test('caches an immutable input and never carries aliases across native scope changes or clear', () => {
    const identity = new HistoryProcessIdentity();
    identity.reconcile([summary('old-shell', tool('retained'))], 'session-1');
    const source = [summary('new-source-key', tool('retained'))];
    const first = identity.reconcile(source, 'session-1');
    expect(first[0].key).toBe('old-shell');
    expect(identity.reconcile(source, 'session-1')).toBe(first);

    expect(identity.reconcile(source, 'session-2')).toBe(source);
    identity.reconcile([summary('scope-2-shell', tool('retained'))], 'session-2');
    identity.clear();
    expect(identity.reconcile(source, 'session-2')).toBe(source);
    expect(identity.reconcile([], 'session-2')).toEqual([]);
  });
});
