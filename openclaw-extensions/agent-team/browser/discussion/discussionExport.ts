import type { TeamDiscussionMessage } from '../../contracts/teamDiscussion';

export function formatDiscussionExportMessage(
  message: TeamDiscussionMessage,
  speaker: string,
): string {
  // Preserve attachment locators as literal text; exporting never reads their files.
  const attachments = message.mediaUrls.map(location =>
    location
      .split(/\r?\n/)
      .map(line => `    ${line}`)
      .join('\n'),
  );
  return [`### ${speaker}`, message.text, ...attachments].filter(Boolean).join('\n\n');
}
