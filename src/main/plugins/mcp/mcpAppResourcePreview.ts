import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { IpcMainInvokeEvent, WebContents } from 'electron';

import {
  isMcpAppResourcePreviewHash,
  isMcpAppResourcePreviewMimeType,
  isMcpAppResourcePreviewName,
  MCP_APP_PREVIEW_MAX_PARTS,
  MCP_APP_PREVIEW_PART_MAX_BYTES,
  type McpAppStagedResourcePreview,
} from '../../../shared/plugins/mcpAppResourcePreview';
import { mcpAppRecord } from '../../../shared/plugins/mcpApps';
import {
  getBrowserFilePreviewKind,
  getPreviewableFileExtension,
  MAX_PREVIEW_FILE_BYTES,
} from '../../../shared/preview/filePreview';

const MAX_STAGING = 2;
const MAX_PREVIEWS = 64;
const MAX_RESERVED_BYTES = 256 * 1024 * 1024;
const EMPTY_BYTES = Buffer.alloc(0);
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const IMAGE_EXTENSION = /\.(?:png|apng|jpe?g|jpe|jfif|pjpeg|pjp|gif|webp|svg|bmp|ico|avif)$/iu;
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);
const MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  pjpeg: 'image/jpeg',
  pjp: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

type Preview = {
  bytes: Buffer;
  path: string;
  mimeType: string;
  event: IpcMainInvokeEvent;
  responses: Set<ServerResponse>;
};
type Owner = {
  previews: Map<string, Preview>;
  staging: boolean;
  stop: () => void;
};

function decodePart(raw: unknown): Buffer {
  const part = mcpAppRecord(raw);
  const byteLength = part?.byteLength;
  const blob = part?.blob;
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MCP_APP_PREVIEW_PART_MAX_BYTES ||
    typeof blob !== 'string' ||
    blob.length !== Math.ceil(byteLength / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(blob)
  )
    throw new Error('Invalid App resource preview part');
  const bytes = Buffer.from(blob, 'base64');
  if (bytes.length !== byteLength || bytes.toString('base64') !== blob)
    throw new Error('Invalid App resource preview part');
  return bytes;
}

function decodePreview(raw: unknown) {
  const input = mcpAppRecord(raw);
  if (
    !isMcpAppResourcePreviewName(input?.name) ||
    !isMcpAppResourcePreviewMimeType(input.mimeType) ||
    !isMcpAppResourcePreviewHash(input.sha256) ||
    !Array.isArray(input.parts) ||
    input.parts.length < 1 ||
    input.parts.length > MCP_APP_PREVIEW_MAX_PARTS
  )
    throw new Error('Invalid App resource preview');
  const parts = input.parts.map(decodePart);
  const hash = createHash('sha256');
  let byteLength = 0;
  for (const part of parts) {
    hash.update(part);
    byteLength += part.length;
  }
  if (hash.digest('hex') !== input.sha256)
    throw new Error('App resource preview failed its integrity check');
  return { name: input.name, bytes: Buffer.concat(parts, byteLength), sha256: input.sha256 };
}

function previewContent(
  name: string,
  bytes: Buffer,
): Pick<McpAppStagedResourcePreview, 'kind' | 'content'> {
  const browserKind = getBrowserFilePreviewKind(name);
  if (browserKind) return { kind: browserKind };
  if (IMAGE_EXTENSION.test(name)) return { kind: 'image' };
  if (getPreviewableFileExtension(name) && bytes.length <= MAX_PREVIEW_FILE_BYTES) {
    try {
      return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { kind: 'unsupported' };
    }
  }
  return { kind: 'unsupported' };
}

function requestRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | false {
  if (value === undefined) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return false;
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  return start < size && start <= end && (first !== undefined || (last ?? 0) > 0)
    ? { start, end }
    : false;
}

/** Serves exact, bounded MCP bytes for the lifetime of owner-held read-only previews. */
export class McpAppResourcePreviews {
  private readonly owners = new Map<WebContents, Owner>();
  private readonly paths = new Map<string, Preview>();
  private readonly pending = new Set<Promise<unknown>>();
  private disposed = false;
  private staging = 0;
  private reserved = 0;
  private reservedBytes = 0;
  private server?: Server;
  private listening?: Promise<string>;
  private origin = '';

  constructor(private readonly isAllowedSender: (event: IpcMainInvokeEvent) => boolean) {}

  private current(event: IpcMainInvokeEvent): boolean {
    return (
      !this.disposed &&
      !event.sender.isDestroyed() &&
      Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame) &&
      this.isAllowedSender(event)
    );
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    const settled = () => this.pending.delete(task);
    void task.then(settled, settled);
    return task;
  }

  private remove(sender: WebContents, owner: Owner, id: string): void {
    const preview = owner.previews.get(id);
    if (!preview) return;
    owner.previews.delete(id);
    this.paths.delete(preview.path);
    preview.responses.forEach(response => response.destroy());
    this.reserved--;
    this.reservedBytes -= preview.bytes.length;
    if (owner.previews.size === 0 && !owner.staging && this.owners.get(sender) === owner) {
      this.owners.delete(sender);
      owner.stop();
    }
  }

  private retire(sender: WebContents, owner: Owner): void {
    if (this.owners.get(sender) !== owner) return;
    this.owners.delete(sender);
    owner.stop();
    for (const id of owner.previews.keys()) this.remove(sender, owner, id);
  }

  private bind(sender: WebContents): Owner {
    const existing = this.owners.get(sender);
    if (existing) return existing;
    const retire = () => this.retire(sender, owner);
    const navigate = (
      _event: Electron.Event,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ) => {
      if (mainFrame && !inPlace) retire();
    };
    const owner: Owner = {
      previews: new Map(),
      staging: false,
      stop: () => {
        sender.removeListener('destroyed', retire);
        sender.removeListener('render-process-gone', retire);
        sender.removeListener('did-start-navigation', navigate);
      },
    };
    this.owners.set(sender, owner);
    sender.on('destroyed', retire);
    sender.on('render-process-gone', retire);
    sender.on('did-start-navigation', navigate);
    return owner;
  }

  private serve(request: IncomingMessage, response: ServerResponse): void {
    const preview = this.paths.get(request.url ?? '');
    const hostHeaders = request.rawHeaders.filter(
      (_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host',
    );
    if (
      !preview ||
      !this.current(preview.event) ||
      request.socket.remoteAddress !== '127.0.0.1' ||
      hostHeaders.length !== 1 ||
      request.headers.host !== new URL(this.origin).host ||
      (request.method !== 'GET' && request.method !== 'HEAD')
    ) {
      response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Length': '0' }).end();
      return;
    }
    if (preview.responses.size >= 8) {
      response.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Length': '0' }).end();
      return;
    }
    const range = requestRange(request.headers.range, preview.bytes.length);
    if (!range) {
      response
        .writeHead(416, {
          'Content-Range': 'bytes */' + preview.bytes.length,
          'Cache-Control': 'no-store',
          'Content-Length': '0',
        })
        .end();
      return;
    }
    response.writeHead(request.headers.range === undefined ? 200 : 206, {
      'Content-Type': preview.mimeType,
      'Content-Length': range.end - range.start + 1,
      ...(request.headers.range === undefined
        ? {}
        : {
            'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + preview.bytes.length,
          }),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    });
    preview.responses.add(response);
    response.once('close', () => preview.responses.delete(response));
    response.end(
      request.method === 'HEAD' ? undefined : preview.bytes.subarray(range.start, range.end + 1),
    );
  }

  private ensureServer(): Promise<string> {
    if (this.listening) return this.listening;
    const server = createServer((request, response) => this.serve(request, response));
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.maxConnections = 16;
    server.maxHeadersCount = 32;
    this.server = server;
    this.listening = (async () => {
      for (let attempt = 0; attempt < 32; attempt++) {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => {
            server.off('listening', ready);
            reject(error);
          };
          const ready = () => {
            server.off('error', failed);
            resolve();
          };
          server.once('error', failed);
          server.once('listening', ready);
          server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
        });
        const address = server.address();
        if (address && typeof address !== 'string' && !BLOCKED_PORTS.has(address.port)) {
          this.origin = 'http://127.0.0.1:' + address.port;
          server.unref();
          return this.origin;
        }
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      throw new Error('Could not allocate a browser-compatible preview port.');
    })().catch(error => {
      server.closeAllConnections();
      server.close();
      this.server = undefined;
      this.listening = undefined;
      throw error;
    });
    return this.listening;
  }

  stage(event: IpcMainInvokeEvent, input: unknown): Promise<McpAppStagedResourcePreview> {
    return this.track(this.stageResource(event, input));
  }

  private async stageResource(
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<McpAppStagedResourcePreview> {
    if (!this.current(event)) throw new Error('App preview window is unavailable');
    const { sender } = event;
    if (
      this.owners.get(sender)?.staging ||
      this.staging >= MAX_STAGING ||
      this.reserved >= MAX_PREVIEWS
    )
      throw new Error('App resource preview limit reached');
    const { name, bytes, sha256 } = decodePreview(input);
    const content = previewContent(name, bytes);
    const retainedBytes = content.kind === 'text' || content.kind === 'unsupported' ? EMPTY_BYTES : bytes;
    if (this.reservedBytes + retainedBytes.length > MAX_RESERVED_BYTES)
      throw new Error('App resource preview limit reached');
    const owner = this.bind(sender);
    owner.staging = true;
    this.staging++;
    this.reserved++;
    this.reservedBytes += retainedBytes.length;
    const id = randomUUID();
    let adopted = false;
    try {
      const resourcePath = '/' + randomBytes(32).toString('hex') + '/' + encodeURIComponent(name);
      const url =
        content.kind === 'text' || content.kind === 'unsupported'
          ? undefined
          : (await this.ensureServer()) + resourcePath;
      if (this.owners.get(sender) !== owner || !this.current(event))
        throw new Error('App preview window changed');
      const extension = name.split('.').pop()?.toLowerCase() ?? '';
      const preview: Preview = {
        bytes: retainedBytes,
        path: resourcePath,
        mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
        event,
        responses: new Set(),
      };
      owner.previews.set(id, preview);
      if (url) this.paths.set(resourcePath, preview);
      adopted = true;
      return {
        ...content,
        filePath: 'mcp-resource://' + id + '/' + name,
        ...(url ? { url } : {}),
        version: sha256,
        resourcePreview: { id, name },
      };
    } finally {
      if (!adopted) {
        this.reserved--;
        this.reservedBytes -= retainedBytes.length;
      }
      owner.staging = false;
      this.staging--;
      if (owner.previews.size === 0 && this.owners.get(sender) === owner) {
        this.owners.delete(sender);
        owner.stop();
      }
    }
  }

  async release(event: IpcMainInvokeEvent, input: unknown): Promise<null> {
    if (!this.current(event) || typeof input !== 'string' || !ID.test(input))
      throw new Error('Invalid App resource preview release');
    const owner = this.owners.get(event.sender);
    if (owner) this.remove(event.sender, owner, input);
    return null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [sender, owner] of this.owners) this.retire(sender, owner);
    await Promise.allSettled(this.pending);
    this.server?.closeAllConnections();
    if (this.server?.listening)
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
    this.listening = undefined;
  }
}
