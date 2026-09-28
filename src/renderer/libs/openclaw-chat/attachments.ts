import {
  type CoworkAttachmentPayload,
  isImageMimeType,
  toAttachmentDataUrl,
} from '@shared/cowork/attachments';

import type { GatewayContentBlock, MessageContentItem } from '@/libs/openclaw-chat/types';

export type RenderableAttachment = Extract<
  MessageContentItem,
  { type: 'attachment' }
>['attachment'];

export type TranscriptMedia = {
  path: string;
  mimeType?: string;
  fileName?: string;
  kind?: string;
};

const IMAGE_PATH_PATTERN =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)(?:[?#].*)?$/iu;

export function isTranscriptImage(media: TranscriptMedia): boolean {
  const mimeType = media.mimeType?.trim().toLowerCase();
  if (mimeType) {
    if (mimeType.startsWith('image/')) return true;
    if (mimeType !== 'application/octet-stream' && mimeType !== 'binary/octet-stream') {
      return false;
    }
  }
  const kind = media.kind?.trim().toLowerCase();
  if (kind) return kind === 'image';
  return IMAGE_PATH_PATTERN.test(media.path);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCanonicalTranscriptMedia(
  record: Record<string, unknown>,
): Array<TranscriptMedia | undefined> {
  const metadata = asRecord(record.__openclaw);
  if (!Array.isArray(metadata?.media)) return [];

  return metadata.media.map(value => {
    const media = asRecord(value);
    if (!media) return undefined;
    const path =
      typeof media.path === 'string' && media.path.trim()
        ? media.path.trim()
        : typeof media.url === 'string' && media.url.trim()
          ? media.url.trim()
          : '';
    const mimeType =
      typeof media.contentType === 'string' && media.contentType.trim()
        ? media.contentType.trim()
        : undefined;
    const fileName =
      typeof media.fileName === 'string' && media.fileName.trim()
        ? media.fileName.trim()
        : undefined;
    const kind =
      typeof media.kind === 'string' && media.kind.trim() ? media.kind.trim() : undefined;
    return {
      path,
      ...(mimeType ? { mimeType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(kind ? { kind } : {}),
    };
  });
}

function readStringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function toAttachmentContentBlocks(
  attachments: CoworkAttachmentPayload[],
): GatewayContentBlock[] {
  return attachments
    .filter(attachment => attachment.base64Data)
    .map(attachment => ({
      type: 'attachment',
      attachment: {
        url: toAttachmentDataUrl(attachment),
        kind: isImageMimeType(attachment.mimeType) ? 'image' : attachment.mimeType.startsWith('audio/') ? 'audio' : attachment.mimeType.startsWith('video/') ? 'video' : 'document',
        label: attachment.name,
        mimeType: attachment.mimeType,
      },
    }));
}

export function getTranscriptMedia(message: unknown): TranscriptMedia[] {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const record = message as Record<string, unknown>;
  const canonical = readCanonicalTranscriptMedia(record);
  const paths = readStringArray(record.MediaPaths);
  const urls = readStringArray(record.MediaUrls);
  const types = readStringArray(record.MediaTypes);
  const count = Math.max(
    canonical.length,
    paths.length,
    urls.length,
    types.length,
    record.MediaPath || record.MediaUrl || record.MediaType ? 1 : 0,
  );

  return Array.from({ length: count }, (_, index): TranscriptMedia | undefined => {
    const fact = canonical[index];
    const legacyPath = readTrimmedString(paths[index] ?? (index === 0 ? record.MediaPath : null));
    const legacyUrl = readTrimmedString(urls[index] ?? (index === 0 ? record.MediaUrl : null));
    const path = fact?.path || legacyPath || legacyUrl;
    if (!path) return undefined;
    const legacyType = readTrimmedString(types[index] ?? (index === 0 ? record.MediaType : null));
    return {
      path,
      ...(fact?.mimeType || legacyType ? { mimeType: fact?.mimeType || legacyType } : {}),
      ...(fact?.fileName ? { fileName: fact.fileName } : {}),
      ...(fact?.kind ? { kind: fact.kind } : {}),
    };
  }).filter((media): media is TranscriptMedia => media !== undefined);
}
