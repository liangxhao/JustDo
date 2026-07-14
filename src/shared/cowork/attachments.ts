export interface CoworkAttachmentPayload {
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface GatewayAttachmentPayload {
  type: 'image' | 'file';
  mimeType: string;
  content: string;
  fileName?: string;
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export function parseCoworkAttachments(value: unknown): CoworkAttachmentPayload[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
    const base64Data = typeof record.base64Data === 'string' ? record.base64Data.trim() : '';
    return mimeType && base64Data ? [{ name: name || 'Attachment', mimeType, base64Data }] : [];
  });
}

export function toAttachmentDataUrl(attachment: CoworkAttachmentPayload): string {
  return attachment.base64Data.startsWith('data:')
    ? attachment.base64Data
    : `data:${attachment.mimeType};base64,${attachment.base64Data}`;
}

export function toGatewayAttachment(attachment: CoworkAttachmentPayload): GatewayAttachmentPayload {
  return isImageMimeType(attachment.mimeType)
    ? {
        type: 'image',
        mimeType: attachment.mimeType,
        content: attachment.base64Data,
      }
    : {
        type: 'file',
        mimeType: attachment.mimeType,
        content: attachment.base64Data,
        fileName: attachment.name,
      };
}
