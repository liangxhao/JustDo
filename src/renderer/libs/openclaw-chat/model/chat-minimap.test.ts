import { describe, expect, test } from 'vitest';

import { projectChatMinimapEntries } from './chat-minimap';
import type { ContentItem } from './chat-transcript-state';
import type { VisibleTimelineItem } from './timeline-avatar-state';

function message(key: string, role: string, content: string): VisibleTimelineItem {
  return {
    kind: 'history-message',
    key,
    message: { role, content },
  };
}

function content(key: string, text: string): VisibleTimelineItem {
  const item: ContentItem = {
    type: 'content',
    id: key,
    runId: 'run-1',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 1,
    updatedAt: 1,
    status: 'streaming',
    text,
    sourceMode: 'snapshot',
  };
  return { kind: 'content', key, item };
}

describe('chat minimap projection', () => {
  test('groups each user message with the following assistant messages', () => {
    const entries = projectChatMinimapEntries([
      message('user-1', 'user', 'First request'),
      message('assistant-1', 'assistant', 'First answer'),
      message('assistant-2', 'assistant', 'More detail'),
      message('user-2', 'user', 'Second request'),
      message('assistant-3', 'assistant', 'Second answer'),
    ]);

    expect(entries).toEqual([
      {
        key: 'minimap:user-1',
        anchorKey: 'user-1',
        userText: 'First request',
        assistantText: 'First answer More detail',
      },
      {
        key: 'minimap:user-2',
        anchorKey: 'user-2',
        userText: 'Second request',
        assistantText: 'Second answer',
      },
    ]);
  });

  test('updates the current turn preview from incremental Content', () => {
    const entries = projectChatMinimapEntries([
      message('user-1', 'user', 'Build the report'),
      content('content-1', 'The report is being generated'),
      content('content-2', 'and is now complete'),
    ]);

    expect(entries[0]?.assistantText).toBe('The report is being generated and is now complete');
  });

  test('supports the direct-property streaming fallback', () => {
    const entries = projectChatMinimapEntries(
      [message('user-1', 'user', 'Build the report')],
      'Streaming answer',
    );

    expect(entries[0]?.assistantText).toBe('Streaming answer');
  });

  test('uses nested history roles and removes markdown and MEDIA lines from previews', () => {
    const entries = projectChatMinimapEntries([
      {
        kind: 'history-message',
        key: 'user-1',
        message: {
          role: 'wrapper',
          message: {
            role: 'user',
            content: '**Review** this\nMEDIA:C:\\files\\report.pdf',
          },
        },
      },
      message('assistant-1', 'assistant', 'Opened `[report](file:///report.pdf)`'),
    ]);

    expect(entries[0]).toMatchObject({
      userText: 'Review this',
      assistantText: 'Opened report',
    });
  });

  test('ignores assistant content before the first user turn', () => {
    expect(
      projectChatMinimapEntries([
        message('assistant-1', 'assistant', 'orphan reply'),
        content('content-1', 'orphan stream'),
      ]),
    ).toEqual([]);
  });
});
