import { describe, expect, test } from 'vitest';

import {
  createProcessSummarySessionIdentity,
  ProcessSummaryTakeoverTracker,
} from './process-summary-takeover';
import type { ProcessSummaryTimelineItem } from './project-turn-items';

function summary(
  key: string,
  options: { runId?: string; toolCallId?: string; thinking?: string } = {},
): ProcessSummaryTimelineItem {
  const runId = options.runId ?? 'run-1';
  return {
    kind: 'process-summary',
    key,
    runId,
    items: options.toolCallId
      ? [
          {
            id: `${key}:tool`,
            runId,
            firstSeq: 1,
            lastSeq: 2,
            startedAt: 1,
            updatedAt: 2,
            type: 'tool',
            status: 'completed',
            toolCallId: options.toolCallId,
            name: 'Read',
          },
        ]
      : [
          {
            id: `${key}:thinking`,
            runId,
            firstSeq: 1,
            lastSeq: 1,
            startedAt: 1,
            updatedAt: 1,
            type: 'thinking',
            status: 'completed',
            text: options.thinking ?? 'Inspecting the repository',
          },
        ],
    thinkingCount: options.toolCallId ? 0 : 1,
    toolCount: options.toolCallId ? 1 : 0,
    errorCount: 0,
    interruptedCount: 0,
  };
}

describe('ProcessSummaryTakeoverTracker', () => {
  test('isolates disclosure state across session ID rotations and history resets', () => {
    const base = {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'backing-session-1',
      historyGeneration: 3,
    };

    expect(createProcessSummarySessionIdentity(base)).not.toBe(
      createProcessSummarySessionIdentity({
        ...base,
        sessionId: 'backing-session-2',
      }),
    );
    expect(createProcessSummarySessionIdentity(base)).not.toBe(
      createProcessSummarySessionIdentity({
        ...base,
        historyGeneration: 4,
      }),
    );
  });

  test('keeps the same key while the live summary is still present', () => {
    const tracker = new ProcessSummaryTakeoverTracker();
    const live = summary('process:run-1:0:item-1');

    expect(tracker.resolve(live.key, [live])).toBe(live.key);
    expect(tracker.resolve(live.key, [live])).toBe(live.key);
  });

  test('maps an expanded live summary to authoritative history by Tool call ID', () => {
    const tracker = new ProcessSummaryTakeoverTracker();
    const live = summary('process:run-1:0:item-1', { toolCallId: 'call-1' });
    const persisted = summary('history-process:4:entry-9', {
      runId: 'history:entry-9',
      toolCallId: 'call-1',
    });

    tracker.resolve(live.key, [live]);

    expect(tracker.resolve(live.key, [persisted])).toBe(persisted.key);
  });

  test('uses an explicit shared run ID when history carries it', () => {
    const tracker = new ProcessSummaryTakeoverTracker();
    const live = summary('live-key', { runId: 'run-shared', thinking: 'live wording' });
    const persisted = summary('persisted-key', {
      runId: 'run-shared',
      thinking: 'normalized history wording',
    });

    tracker.resolve(live.key, [live]);

    expect(tracker.resolve(live.key, [persisted])).toBe(persisted.key);
  });

  test('rejects ambiguous thinking-only correlations', () => {
    const tracker = new ProcessSummaryTakeoverTracker();
    const live = summary('live-key', { runId: 'run-live', thinking: 'same thought' });
    const first = summary('persisted-1', { runId: 'history-1', thinking: 'same thought' });
    const second = summary('persisted-2', { runId: 'history-2', thinking: 'same thought' });

    tracker.resolve(live.key, [live]);

    expect(tracker.resolve(live.key, [first, second])).toBeNull();
  });

  test('does not carry an unrelated expanded summary', () => {
    const tracker = new ProcessSummaryTakeoverTracker();
    const live = summary('live-key', { toolCallId: 'call-live' });
    const unrelated = summary('persisted-key', {
      runId: 'history-run',
      toolCallId: 'call-other',
    });

    tracker.resolve(live.key, [live]);

    expect(tracker.resolve(live.key, [unrelated])).toBeNull();
  });
});
