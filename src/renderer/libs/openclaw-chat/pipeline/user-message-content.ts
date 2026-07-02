import type { ChatAttachment, GatewayContentBlock } from '../types';

export function buildUserChatMessageContentBlocks(
  text: string,
  attachments?: ChatAttachment[],
): GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = text ? [{ type: 'text', text }] : [];

  for (const attachment of attachments ?? []) {
    if (!attachment.mimeType.startsWith('image/') || !attachment.previewUrl) continue;
    blocks.push({
      type: 'attachment',
      attachment: {
        url: attachment.previewUrl,
        kind: 'image',
        label: attachment.name,
        mimeType: attachment.mimeType,
      },
    });
  }

  return blocks;
}
