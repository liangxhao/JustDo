import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CoworkAttachmentPayload } from '../../shared/cowork/attachments';
import { AppServerErrorCode, AppServerRpcError, isAppServerRecord } from './appServerProtocol';

export const APP_SERVER_MAX_IMAGES = 5;
export const APP_SERVER_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const APP_SERVER_MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type AppServerInputContent =
  | { type: 'text'; text: string; text_elements: never[] }
  | { type: 'image'; url: string };

export interface AppServerImageBytes {
  bytes: Uint8Array;
  mimeType: string;
}

export interface AppServerInputOptions {
  cwd: string;
  /** Local paths are a host capability, never enabled by client capabilities. */
  allowLocalImages?: boolean;
  /** Only set when the caller has separately validated real attachments. */
  allowEmptyForAttachments?: boolean;
  signal?: AbortSignal;
  /** Host-owned network policy. Omission rejects HTTP(S) input. */
  fetchImage?: (url: string, options: { signal?: AbortSignal; maxBytes: number }) => Promise<AppServerImageBytes>;
}

const invalid = (message: string): never => {
  throw new AppServerRpcError(AppServerErrorCode.InvalidParams, message);
};

function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function mimeForBytes(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function dataImage(url: string, maxBytes: number): AppServerImageBytes {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
  if (!match || !match[2] || match[2].length % 4 !== 0 || match[2].length > Math.ceil(maxBytes / 3) * 4)
    return invalid('image.url must contain a bounded PNG, JPEG, GIF or WebP base64 data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) invalid('image.url contains invalid base64 data.');
  return { bytes, mimeType: match[1].toLowerCase() };
}

/** Authenticated history uses the same bounded byte validation as new input. */
export function normalizeAppServerImageDataUrl(url: string): string {
  const decoded = dataImage(url, APP_SERVER_MAX_IMAGE_BYTES);
  if (mimeForBytes(decoded.bytes) !== decoded.mimeType) invalid('Image data does not match its declared media type.');
  return `data:${decoded.mimeType};base64,${Buffer.from(decoded.bytes).toString('base64')}`;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function localImage(file: string, options: AppServerInputOptions, maxBytes: number): Promise<AppServerImageBytes> {
  if (!options.allowLocalImages) invalid('localImage is not available through this connection.');
  const root = await realpath(options.cwd);
  const target = await realpath(path.resolve(root, file));
  if (!within(root, target)) invalid('localImage must be a file inside the bound working directory.');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    abort(options.signal);
    const before = await handle.stat({ bigint: true });
    const atPath = await stat(target, { bigint: true });
    if (before.dev !== atPath.dev || before.ino !== atPath.ino)
      invalid('localImage changed while it was being opened.');
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) invalid('localImage exceeds the image size limit or is not a file.');
    if (await realpath(options.cwd) !== root || await realpath(path.resolve(root, file)) !== target)
      invalid('localImage changed while it was being opened.');
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, Number(before.size) + 1));
    let length = 0;
    for (;;) {
      abort(options.signal);
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      length += bytesRead;
      if (!bytesRead || length === bytes.length) break;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await stat(target, { bigint: true });
    if (BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ino !== after.ino || before.dev !== after.dev || before.ino !== pathAfter.ino || before.dev !== pathAfter.dev ||
      await realpath(options.cwd) !== root || await realpath(path.resolve(root, file)) !== target)
      invalid('localImage changed while it was being read.');
    const content = bytes.subarray(0, length);
    return { bytes: content, mimeType: mimeForBytes(content) ?? '' };
  } finally {
    await handle.close();
  }
}

/** Decode real image bytes once. Native execution normalizes text and ordered images separately. */
export async function prepareAppServerInput(
  input: unknown,
  options: AppServerInputOptions,
): Promise<{ message: string; attachments: CoworkAttachmentPayload[]; content: AppServerInputContent[] }> {
  if (!Array.isArray(input) || input.length > 128) return invalid('input must be an array of at most 128 text and image elements.');
  const content: AppServerInputContent[] = [];
  const attachments: CoworkAttachmentPayload[] = [];
  const texts: string[] = [];
  let imageBytes = 0;
  let textBytes = 0;
  for (const item of input) {
    abort(options.signal);
    if (!isAppServerRecord(item)) invalid('input elements must be objects.');
    if (item.type === 'text') {
      if (typeof item.text !== 'string') invalid('text input requires text.');
      if (item.text_elements != null && (!Array.isArray(item.text_elements) || item.text_elements.length > 0))
        invalid('Text element annotations are not supported.');
      textBytes += Buffer.byteLength(item.text, 'utf8') + (texts.length ? 1 : 0);
      if (textBytes > APP_SERVER_MAX_TEXT_BYTES) invalid('Text input exceeds the size limit.');
      texts.push(item.text);
      continue;
    }
    if (item.type !== 'image' && item.type !== 'localImage')
      invalid('Only text, image and localImage input are supported; audio and file IDs are unavailable.');
    if (item.fileId != null || (item.detail != null && item.detail !== 'auto'))
      invalid('Image file IDs and image detail overrides are not supported.');
    if (attachments.length >= APP_SERVER_MAX_IMAGES) invalid('At most five images are supported per input.');
    const remaining = APP_SERVER_MAX_IMAGE_BYTES - imageBytes;
    let decoded: AppServerImageBytes;
    try {
      if (item.type === 'localImage') {
        if (typeof item.path !== 'string' || !item.path || item.path.includes('\0')) invalid('localImage requires a file path.');
        decoded = await localImage(item.path, options, remaining);
      } else {
        if (typeof item.url !== 'string' || !item.url) invalid('image requires a URL.');
        if (item.url.startsWith('data:')) decoded = dataImage(item.url, remaining);
        else if (options.fetchImage) {
          const url = new URL(item.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
            invalid('image.url must be an HTTP(S) URL without credentials or fragment.');
          decoded = await options.fetchImage(url.href, { signal: options.signal, maxBytes: remaining });
        }
        else invalid('Only image data URLs are available through this connection.');
      }
    } catch (error) {
      abort(options.signal);
      if (error instanceof AppServerRpcError) throw error;
      invalid('The image could not be read through the configured host policy.');
    }
    abort(options.signal);
    imageBytes += decoded.bytes.byteLength;
    const mimeType = mimeForBytes(decoded.bytes);
    if (!mimeType || mimeType !== decoded.mimeType.toLowerCase() || imageBytes > APP_SERVER_MAX_IMAGE_BYTES)
      invalid('Image data is invalid or exceeds the combined four MiB size limit.');
    const base64Data = Buffer.from(decoded.bytes).toString('base64');
    attachments.push({ name: `image-${attachments.length + 1}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)}`, mimeType, base64Data });
    content.push({ type: 'image', url: `data:${mimeType};base64,${base64Data}` });
  }
  const message = texts.join('\n');
  if (!message.trim() && attachments.length === 0 && !options.allowEmptyForAttachments)
    invalid('input must contain text or an image.');
  const normalized: AppServerInputContent[] = [
    ...(message.trim() ? [{ type: 'text' as const, text: message, text_elements: [] as never[] }] : []),
    ...content,
  ];
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 6 * 1024 * 1024)
    invalid('Encoded input exceeds the protocol response size limit.');
  return { message, attachments, content: normalized };
}
