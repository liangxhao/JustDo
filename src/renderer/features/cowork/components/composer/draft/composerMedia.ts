import type { DraftAttachment } from '@/features/cowork/coworkSlice';

import { isImagePath } from '../attachments/composerAttachmentFiles';

export const isImageAttachment = (attachment: DraftAttachment): boolean =>
  attachment.isImage === true ||
  isImagePath(attachment.path) ||
  attachment.dataUrl?.startsWith('data:image/') === true;

export const extractBase64FromDataUrl = (
  dataUrl: string,
): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const toMediaDirectivePath = (filePath: string): string => {
  return filePath.replace(/[\r\n]+/g, ' ').trim();
};

export const appendMediaDirectiveLines = (prompt: string, filePaths: string[]): string => {
  const mediaLines = filePaths
    .map(toMediaDirectivePath)
    .filter(Boolean)
    .map(filePath => `MEDIA:${filePath}`);
  if (mediaLines.length === 0) return prompt;
  return prompt ? `${prompt}\n\n${mediaLines.join('\n')}` : mediaLines.join('\n');
};
