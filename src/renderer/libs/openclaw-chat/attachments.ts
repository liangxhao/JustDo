import {
  type CoworkAttachmentPayload,
  isImageMimeType,
  toAttachmentDataUrl,
} from '@shared/coworkAttachment';

import type { GatewayContentBlock, MessageContentItem } from './types';

export type RenderableAttachment = Extract<
  MessageContentItem,
  { type: 'attachment' }
>['attachment'];

export function toAttachmentContentBlocks(
  attachments: CoworkAttachmentPayload[],
): GatewayContentBlock[] {
  return attachments
    .filter(attachment => attachment.base64Data)
    .map(attachment => ({
      type: 'attachment',
      attachment: {
        url: toAttachmentDataUrl(attachment),
        kind: isImageMimeType(attachment.mimeType) ? 'image' : 'document',
        label: attachment.name,
        mimeType: attachment.mimeType,
      },
    }));
}

export function getTranscriptMedia(message: unknown): Array<{ path: string; mimeType?: string }> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const record = message as Record<string, unknown>;
  const paths = Array.isArray(record.MediaPaths)
    ? record.MediaPaths.filter((value): value is string => typeof value === 'string')
    : typeof record.MediaPath === 'string'
      ? [record.MediaPath]
      : [];
  const types = Array.isArray(record.MediaTypes)
    ? record.MediaTypes
    : typeof record.MediaType === 'string'
      ? [record.MediaType]
      : [];

  return paths.map((path, index) => ({
    path,
    ...(typeof types[index] === 'string' ? { mimeType: types[index] } : {}),
  }));
}
