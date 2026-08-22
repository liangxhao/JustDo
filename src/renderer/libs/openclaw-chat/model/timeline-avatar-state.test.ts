import { describe, expect, test } from 'vitest';

import { FAILED_RUN_MESSAGE_FLAG } from './failed-run-message';
import type { VisibleTimelineItem } from './timeline-avatar-state';
import { prepareVisibleTimelineRows } from './timeline-avatar-state';

function history(key: string, role: string): VisibleTimelineItem {
  return {
    kind: 'history-message',
    key,
    message: { role, content: `${role} content` },
  };
}

function summary(key: string): VisibleTimelineItem {
  return {
    kind: 'process-summary',
    key,
    runId: 'run-1',
    items: [],
    thinkingCount: 1,
    toolCount: 1,
    errorCount: 0,
    interruptedCount: 0,
  };
}

describe('timeline avatar state', () => {
  test('shows one assistant avatar across multiple summary and Content segments in a turn', () => {
    const rows = prepareVisibleTimelineRows([
      history('user-1', 'user'),
      summary('summary-1'),
      history('content-1', 'assistant'),
      summary('summary-2'),
      history('content-2', 'assistant'),
    ]);

    expect(rows.map(row => row.showAvatar)).toEqual([true, true, false, false, false]);
    expect(rows.map(row => row.showFooter)).toEqual([true, false, false, false, true]);
  });

  test('starts a new assistant avatar after the next user message', () => {
    const rows = prepareVisibleTimelineRows([
      summary('summary-1'),
      history('content-1', 'assistant'),
      history('user-2', 'user'),
      summary('summary-2'),
      history('content-2', 'assistant'),
    ]);

    expect(rows.map(row => row.showAvatar)).toEqual([true, false, true, true, false]);
    expect(rows.map(row => row.showFooter)).toEqual([false, true, true, false, true]);
  });

  test('shows the assistant footer only on the last persisted message in a turn', () => {
    const rows = prepareVisibleTimelineRows([
      history('user-1', 'user'),
      history('content-1', 'assistant'),
      summary('summary-1'),
      history('content-2', 'assistant'),
      history('content-3', 'assistant'),
    ]);

    expect(rows.map(row => row.showFooter)).toEqual([true, false, false, false, true]);
  });

  test('hides the trailing persisted footer while an active turn is still updating', () => {
    const rows = prepareVisibleTimelineRows(
      [
        history('user-1', 'user'),
        history('content-1', 'assistant'),
        history('user-2', 'user'),
        history('content-2', 'assistant'),
        summary('active-summary'),
      ],
      { suppressTrailingAssistantFooter: true },
    );

    expect(rows.map(row => row.showFooter)).toEqual([true, true, true, false, false]);
  });

  test('hides a failed-run message footer when the run metadata footer follows', () => {
    const failedRun: VisibleTimelineItem = {
      kind: 'history-message',
      key: 'failed-run',
      message: {
        role: 'system',
        content: 'API rate limit reached. Please try again later.',
        timestamp: 2_000,
        isError: true,
        [FAILED_RUN_MESSAGE_FLAG]: true,
      },
    };

    const rows = prepareVisibleTimelineRows([history('user-1', 'user'), failedRun], {
      suppressTrailingAssistantFooter: true,
    });

    expect(rows.map(row => row.showFooter)).toEqual([true, false]);
  });

  test('keeps ordinary system and tool error footers visible', () => {
    const systemMessage: VisibleTimelineItem = {
      kind: 'history-message',
      key: 'system-message',
      message: {
        role: 'system',
        content: 'A background operation failed',
        timestamp: 2_000,
        isError: true,
      },
    };
    const toolMessage: VisibleTimelineItem = {
      kind: 'history-message',
      key: 'tool-message',
      message: {
        role: 'tool',
        content: 'Process exited with code 1',
        timestamp: 2_100,
        isError: true,
      },
    };

    const rows = prepareVisibleTimelineRows(
      [history('user-1', 'user'), systemMessage, toolMessage],
      { suppressTrailingAssistantFooter: true },
    );

    expect(rows.map(row => row.showFooter)).toEqual([true, true, true]);
  });

  test('recognizes a marked failed-run message inside a gateway envelope', () => {
    const failedRun: VisibleTimelineItem = {
      kind: 'history-message',
      key: 'failed-run-envelope',
      message: {
        role: 'event',
        content: '',
        message: {
          role: 'system',
          content: 'API rate limit reached. Please try again later.',
          timestamp: 2_000,
          isError: true,
          [FAILED_RUN_MESSAGE_FLAG]: true,
        },
      },
    };

    const rows = prepareVisibleTimelineRows([history('user-1', 'user'), failedRun], {
      suppressTrailingAssistantFooter: true,
    });

    expect(rows.map(row => row.showFooter)).toEqual([true, false]);
  });
});
