import type { TeamDiscussionMessage } from '../../contracts/teamDiscussion';
import { expect, it } from 'vitest';

import { formatDiscussionExportMessage } from './discussionExport';

it.each(['user', 'assistant'] as const)(
  'preserves %s attachment references in exported Markdown',
  role => {
    const message: TeamDiscussionMessage = {
      id: 'message',
      discussionId: 'batch',
      sequence: 1,
      role,
      text: 'Review results',
      timestamp: 1,
      mediaUrls: ['C:\\project\\report [draft].pdf', 'https://example.test/chart.png'],
    };
    const result = formatDiscussionExportMessage(message, 'Speaker');
    expect(result).toBe(
      '### Speaker\n\nReview results\n\n    C:\\project\\report [draft].pdf\n\n    https://example.test/chart.png',
    );
    expect(message.mediaUrls).toHaveLength(2);
  },
);
