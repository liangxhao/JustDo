import { createHash } from 'node:crypto';

export const discussionOperationId = (kind: 'discussion' | 'summary', discussionId: string): string =>
  createHash('sha256').update(JSON.stringify([kind, discussionId])).digest('hex');
