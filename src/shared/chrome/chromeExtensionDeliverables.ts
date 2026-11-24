import { isLocalAssistantDeliverableSource, unwrapAssistantDeliverableSource } from '../openclaw/assistantDeliverables';
import { parseManagedOutgoingMediaSource } from '../openclaw/assistantMedia';
import { filterMediaDirectiveLines } from '../openclaw/mediaDirectives';

export interface AssistantDeliverable {
  source: string;
  name: string;
  mimeType?: string;
  kind: 'image' | 'audio' | 'video' | 'document';
}

const mimeByExtension: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function getChromeDeliveryMediaUrls(message: unknown): string[] {
  return [...new Set(list(record(record(message)?.openclawDelivery)?.mediaUrls).map(string).filter(Boolean))];
}

function parseUrl(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

function fileName(source: string): string {
  if (!source || /^(?:data|blob|javascript):/iu.test(source)) return '';
  if (/^(?:https?|file|localfile|media):/iu.test(source)) {
    const url = parseUrl(source);
    const leaf = url?.pathname.split('/').filter(Boolean).pop();
    if (!leaf) return '';
    try { return decodeURIComponent(leaf); } catch { return leaf; }
  }
  return source.split(/[\\/]/u).pop() ?? '';
}

function safeName(value: string): string {
  const cleaned = value.split(/[\\/]/u).pop()?.replace(/[\x00-\x1f\x7f]/gu, '').trim() ?? '';
  return cleaned === '.' || cleaned === '..' || /^[a-z][\w+.-]*:/iu.test(cleaned)
    ? ''
    : [...cleaned].slice(0, 255).join('');
}

function contentType(value: unknown): string | undefined {
  const mime = string(value).split(';', 1)[0].trim().toLowerCase();
  return mime.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime)
    ? mime
    : undefined;
}

function describe(source: string, details: Record<string, unknown>, forSidePanel: boolean): AssistantDeliverable | undefined {
  const unwrapped = unwrapAssistantDeliverableSource(source);
  const managed = parseManagedOutgoingMediaSource(unwrapped) !== null;
  const managedImageName = managed && details.type === 'image' ? string(details.alt) : '';
  const name = safeName(string(details.fileName) || string(details.label) || string(details.name)) ||
    (managed ? safeName(managedImageName) || 'attachment' : safeName(fileName(unwrapped)));
  if (!name) return undefined;
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1].toLowerCase();
  const inferredMimeType = extension && Object.prototype.hasOwnProperty.call(mimeByExtension, extension)
    ? mimeByExtension[extension]
    : undefined;
  const mimeType = contentType(details.contentType ?? details.mimeType ?? details.media_type) ?? inferredMimeType;
  const declaredKind = details.kind ?? details.type;
  const untypedBinary = mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream';
  const mediaKind = forSidePanel && untypedBinary
    ? inferredMimeType?.split('/')[0] ?? declaredKind
    : mimeType?.split('/')[0] ?? declaredKind;
  const kind = mediaKind === 'image' || mediaKind === 'audio' || mediaKind === 'video'
    ? mediaKind
    : 'document';
  return { source, name, kind, ...(mimeType ? { mimeType } : {}) };
}

/** Read explicit deliveries from one assistant message. Never treat a Markdown link as a delivery. */
export function getWebLaunchAssistantDeliverables(message: unknown): AssistantDeliverable[] {
  return readAssistantDeliverables(message, false);
}

/** Keep declared files in Chrome when native display media does not identify a replacement. */
export function getChromeAssistantDeliverables(message: unknown): AssistantDeliverable[] {
  return readAssistantDeliverables(message, true);
}

function readAssistantDeliverables(message: unknown, forSidePanel: boolean): AssistantDeliverable[] {
  const row = record(message);
  if (row?.role !== 'assistant' || row.display === false) return [];
  const delivered = getChromeDeliveryMediaUrls(row);
  const deliveredSet = new Set(delivered);
  const managedBlocks = new Set<string>();
  const declarations = new Map<string, Record<string, unknown>>();
  const add = (value: unknown, details: Record<string, unknown> = {}) => {
    const source = string(value);
    if (!source || source.length > 4096 || /[\x00-\x1f\x7f]/u.test(source)) return;
    if (!declarations.has(source)) declarations.set(source, details);
  };
  const describeBlock = (block: Record<string, unknown>) => {
    add(string(block.path) || string(block.url), block);
    if (deliveredSet.has(string(block.url))) add(block.url, block);
  };
  const describeContentBlock = (block: Record<string, unknown>) => {
    const url = string(block.url);
    if (parseManagedOutgoingMediaSource(url)) {
      managedBlocks.add(url);
      add(url, block);
    } else {
      describeBlock(block);
    }
  };
  for (const media of list(record(row.__openclaw)?.media)) {
    const item = record(media);
    if (item) describeBlock(item);
  }
  const paths = list(row.MediaPaths);
  const urls = list(row.MediaUrls);
  const types = list(row.MediaTypes);
  for (let index = 0; index < Math.max(paths.length, urls.length, 1); index++) {
    const path = string(paths[index] ?? (index === 0 ? row.MediaPath : undefined));
    const url = urls[index] ?? (index === 0 ? row.MediaUrl : undefined);
    add(path || url, { contentType: types[index] ?? (index === 0 ? row.MediaType : undefined) });
  }

  const blocks = list(row.content).flatMap(value => {
    const item = record(value);
    return item ? [item] : [];
  });
  for (const block of blocks) {
    if (block.type === 'attachment') {
      const attachment = record(block.attachment);
      if (attachment) describeContentBlock(attachment);
    } else if (['audio', 'video', 'file'].includes(String(block.type)) ||
               (block.type === 'image' && parseManagedOutgoingMediaSource(block.url))) {
      describeContentBlock(block);
    }
  }
  if (!delivered.length) {
    const blockText = blocks.filter(block => block.type === 'text').map(block => string(block.text)).join('\n');
    const body = typeof row.content === 'string' ? row.content :
      blocks.length && (!forSidePanel || blockText.trim()) ? blockText : string(row.text);
    filterMediaDirectiveLines(body, source => {
      add(source);
      return false;
    });
  }
  // Native keeps the original MEDIA aliases alongside the materialized display blocks.
  // Use the authenticated file route once present, while retaining exact manifest
  // identity on rows whose manifest already contains those routes.
  const describeSource = (source: string) => {
    if (!source || source.length > 4096 || /[\x00-\x1f\x7f]/u.test(source)) return [];
    const result = describe(source, declarations.get(source) ?? {}, forSidePanel);
    return result ? [result] : [];
  };
  if (!delivered.length) return [...declarations.keys()].flatMap(describeSource);
  if (!managedBlocks.size || delivered.some(source => parseManagedOutgoingMediaSource(source))) {
    return delivered.flatMap(describeSource);
  }
  const managed = [...managedBlocks].flatMap(describeSource);
  if (!forSidePanel) return managed;

  // A complete native batch can identify the managed replacement for each
  // original. An incomplete batch doesn't identify which originals succeeded.
  const originals = delivered.flatMap(describeSource);
  const managedKinds = new Map(managed.map(item => [item.name, item.kind] as const));
  const originalNames = new Set(originals.map(item => item.name));
  const complete = originals.length === delivered.length && originals.length === managedBlocks.size &&
    originalNames.size === originals.length && managedKinds.size === managedBlocks.size &&
    !blocks.some(block => block.type === 'attachment_error') &&
    originals.every(({ source, name, kind }) => isLocalAssistantDeliverableSource(source) && managedKinds.get(name) === kind);
  return complete ? managed : [...managed, ...originals];
}
