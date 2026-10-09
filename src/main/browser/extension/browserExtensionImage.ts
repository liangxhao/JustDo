import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserExtensionMessage } from './browserExtensionChatServer';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Only read image references already present in this thread's native history. */
export async function readThreadImage(
  source: string,
  cwd: string,
  messages: BrowserExtensionMessage[],
): Promise<string> {
  if (!source || source.length > 4096 || /[\r\n\0]/.test(source))
    throw new Error('Invalid image reference.');
  const decode = (value: string) => {
    try {
      return decodeURI(value);
    } catch {
      return value;
    }
  };
  const reference = decode(source);
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markdown = new RegExp(`!\\[[^\\]]*\\]\\(<?${escaped}>?(?:\\s+["'][^"']*["'])?\\)`);
  const media = new RegExp(`(?:^|\\s)MEDIA:\\s*["']?${escaped}(?:["']?(?:\\s|$))`);
  const attached = new RegExp(`\\[media attached: ${escaped}(?:\\s|\\])`);
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const matchesPath = (value: unknown): boolean =>
    typeof value === 'string' && decode(value.trim()) === reference;
  const matchesText = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const decoded = decode(value);
    return markdown.test(decoded) || media.test(decoded) || attached.test(decoded);
  };
  const matchesPaths = (value: unknown): boolean => Array.isArray(value) && value.some(matchesPath);
  const matchesBlock = (value: unknown): boolean => {
    const block = asRecord(value);
    if (!block) return false;
    if (block.type === 'text') return matchesText(block.text);
    if (block.type === 'attachment') {
      const attachment = asRecord(block.attachment);
      return attachment?.kind === 'image' && matchesPath(attachment.url);
    }
    if (!['image', 'image_url', 'input_image'].includes(String(block.type))) return false;
    return matchesPath(
      block.url ??
        asRecord(block.image_url)?.url ??
        (typeof block.image_url === 'string' ? block.image_url : asRecord(block.source)?.url),
    );
  };
  const referencesImage = (message: BrowserExtensionMessage): boolean => {
    if (message.role !== 'user' && message.role !== 'assistant') return false;
    const raw = message.rawMessage;
    if (!raw) return matchesText(message.text);
    const content = raw.content;
    if (Array.isArray(content) ? content.some(matchesBlock) : matchesText(content)) return true;
    const canonical = asRecord(raw.__openclaw)?.media;
    if (
      Array.isArray(canonical) &&
      canonical.some(value => {
        const item = asRecord(value);
        return item && matchesPath(item.path || item.url);
      })
    )
      return true;
    return (
      matchesPath(raw.MediaPath) ||
      matchesPath(raw.MediaUrl) ||
      matchesPaths(raw.MediaPaths) ||
      matchesPaths(raw.MediaUrls) ||
      (message.role === 'assistant' && matchesPaths(asRecord(raw.openclawDelivery)?.mediaUrls))
    );
  };
  if (!messages.some(referencesImage))
    throw new Error('Image is not referenced by this conversation.');
  let filePath = source;
  if (/^(?:file|localfile):/i.test(filePath))
    filePath = fileURLToPath(filePath.replace(/^localfile:/i, 'file:'));
  else if (/^[a-z][a-z\d+.-]*:/i.test(filePath) && !/^[a-z]:[\\/]/i.test(filePath))
    throw new Error('Unsupported image source.');
  if (!/^(?:file|localfile):/i.test(source)) filePath = decode(filePath);
  // Check after decoding and resolution: encoded backslashes and a network cwd
  // must not turn transcript references into SMB filesystem requests.
  const rejectNetworkPath = (value: string) => {
    if (/^[\\/]{2}/.test(value)) throw new Error('Network image paths are unavailable.');
  };
  rejectNetworkPath(filePath);
  if (!path.isAbsolute(filePath) && !cwd)
    throw new Error('Image working directory is unavailable.');
  filePath = path.resolve(cwd, filePath);
  rejectNetworkPath(filePath);
  const mime = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error('Unsupported image type.');
  filePath = await realpath(filePath);
  rejectNetworkPath(filePath);
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
      throw new Error('Image exceeds preview size limit.');
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_IMAGE_BYTES) throw new Error('Image exceeds preview size limit.');
    return `data:${mime};base64,${buffer.subarray(0, bytesRead).toString('base64')}`;
  } finally {
    await file.close();
  }
}
