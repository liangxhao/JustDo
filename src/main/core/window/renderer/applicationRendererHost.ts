import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import { buildApplicationContentSecurityPolicy } from './applicationContentSecurityPolicy';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 4096;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
};
const ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.wasm',
]);
const PDF_ASSET_EXTENSIONS = new Set(['.js', '.wasm', '.bcmap', '.pfb', '.ttf', '.otf', '.icc']);

type PackagedAssetMetadata = {
  absolutePath: string;
  size: number;
  modifiedAt: number;
};
type PackagedAsset = PackagedAssetMetadata & { digest: string };

export type ApplicationRendererHost = {
  origin: string;
  url: string;
  close: () => Promise<void>;
};

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const allowedPackagedAsset = (relative: string): boolean => {
  const segments = relative.split('/');
  if (
    segments.some(
      segment =>
        !segment || segment.startsWith('.') || /[\\:%?#\u0000-\u001f\u007f]/u.test(segment),
    )
  )
    return false;
  if (['index.html', 'image-preview.html', 'workspace.html'].includes(relative)) return true;
  const extension = path.extname(relative).toLowerCase();
  if (segments[0] === 'assets') return ASSET_EXTENSIONS.has(extension);
  return (
    segments.length === 3 &&
    segments[0] === 'pdfjs' &&
    ['cmaps', 'standard_fonts', 'wasm', 'iccs'].includes(segments[1]) &&
    PDF_ASSET_EXTENSIONS.has(extension)
  );
};

/** Decode before checking segments so URL normalization cannot hide traversal. */
const requestAssetPath = (rawUrl: string | undefined): string | null => {
  if (
    !rawUrl ||
    rawUrl.length > 2048 ||
    !rawUrl.startsWith('/') ||
    rawUrl.startsWith('//') ||
    rawUrl.includes('#')
  )
    return null;
  try {
    const queryIndex = rawUrl.indexOf('?');
    const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    if (queryIndex !== -1) {
      const query = new URLSearchParams(rawUrl.slice(queryIndex + 1));
      if (
        pathname !== '/workspace.html' ||
        [...query].length !== 1 ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(query.get('generation') ?? '')
      )
        return null;
    }
    if (/%(?:2f|5c)/iu.test(pathname)) return null;
    const decoded = decodeURIComponent(pathname);
    const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
    return allowedPackagedAsset(relative) ? relative : null;
  } catch {
    return null;
  }
};

const digestAsset = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const readPackagedAsset = async (
  root: string,
  asset: PackagedAssetMetadata & { digest?: string },
): Promise<Buffer> => {
  const assertCurrent = async (): Promise<void> => {
    if (
      (await realpath(root)) !== root ||
      (await realpath(asset.absolutePath)) !== asset.absolutePath
    ) {
      throw new Error('Packaged asset path changed');
    }
    const stats = await lstat(asset.absolutePath);
    if (
      !isWithinRoot(root, asset.absolutePath) ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size !== asset.size ||
      stats.mtimeMs !== asset.modifiedAt
    ) {
      throw new Error('Packaged asset changed');
    }
  };
  await assertCurrent();
  // Electron's ASAR-aware readFile supports packaged virtual assets; raw fd APIs do not.
  const bytes = await readFile(asset.absolutePath);
  await assertCurrent();
  if (
    bytes.byteLength !== asset.size ||
    (asset.digest !== undefined && digestAsset(bytes) !== asset.digest)
  )
    throw new Error('Packaged asset changed');
  return bytes;
};

const collectPackagedAssets = async (
  directory: string,
): Promise<{ root: string; assets: Map<string, PackagedAsset> }> => {
  const absolute = path.resolve(directory);
  const rootStats = await lstat(absolute);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    throw new Error('Invalid packaged renderer directory');
  const root = await realpath(absolute);
  const assets = new Map<string, PackagedAsset>();
  const visit = async (relative: string): Promise<void> => {
    const candidate = path.join(root, relative);
    const stats = await lstat(candidate);
    if (
      stats.isSymbolicLink() ||
      (await realpath(candidate)) !== candidate ||
      !isWithinRoot(root, candidate)
    )
      return;
    if (stats.isDirectory()) {
      if (relative && !/^(?:assets|pdfjs)(?:[/\\]|$)/u.test(relative)) return;
      if (relative.split(path.sep).length > 16)
        throw new Error('Packaged renderer asset tree too deep');
      for (const child of await readdir(candidate)) {
        if (!child.startsWith('.')) await visit(path.join(relative, child));
      }
      return;
    }
    const resource = relative.split(path.sep).join('/');
    if (!stats.isFile() || !allowedPackagedAsset(resource) || stats.size > MAX_ASSET_BYTES) return;
    if (assets.size >= MAX_ASSETS) throw new Error('Too many packaged renderer assets');
    const metadata = { absolutePath: candidate, size: stats.size, modifiedAt: stats.mtimeMs };
    const bytes = await readPackagedAsset(root, metadata);
    assets.set(resource, { ...metadata, digest: digestAsset(bytes) });
  };
  await visit('');
  if (!assets.has('index.html')) throw new Error('Packaged renderer entry missing');
  return { root, assets };
};

/** A read-only artifact server: no workspace roots, routes, credentials or IPC endpoints. */
export const startApplicationRendererHost = async (
  directory: string,
): Promise<ApplicationRendererHost> => {
  const { root, assets } = await collectPackagedAssets(directory);
  const index = await readPackagedAsset(root, assets.get('index.html')!);
  const inlineScriptHashes = [
    ...index.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu),
  ]
    .filter(match => !/\bsrc\s*=/iu.test(match[1]))
    // HTML parsing normalizes CRLF/CR before CSP hashes the script text.
    .map(
      match =>
        `sha256-${createHash('sha256').update(match[2].replace(/\r\n?/gu, '\n')).digest('base64')}`,
    );
  const policy = buildApplicationContentSecurityPolicy({ isDev: false, inlineScriptHashes });
  let origin = '';
  let closed = false;
  const reject = (response: ServerResponse, status: number): void => {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Length': '0',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end();
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const hostHeaders = request.rawHeaders.filter(
      (_value, position) =>
        position % 2 === 0 && request.rawHeaders[position].toLowerCase() === 'host',
    );
    if (
      closed ||
      request.socket.remoteAddress !== LOOPBACK_HOST ||
      hostHeaders.length !== 1 ||
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      (request.headers['sec-fetch-site'] !== undefined &&
        !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))
    ) {
      reject(response, 403);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reject(response, 405);
      return;
    }
    const relative = requestAssetPath(request.url);
    const asset = relative ? assets.get(relative) : undefined;
    if (!asset) {
      reject(response, 404);
      return;
    }
    try {
      const bytes = await readPackagedAsset(root, asset);
      if (closed || response.destroyed) return;
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(asset.absolutePath).toLowerCase()],
        'Content-Length': bytes.byteLength,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': policy,
        'Referrer-Policy': 'origin',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      reject(response, 404);
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) reject(response, 404);
      else response.destroy();
    });
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener('error', rejectListen);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Invalid application listener');
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  server.unref();
  let closing: Promise<void> | undefined;
  return {
    origin,
    url: `${origin}/index.html`,
    close: () => {
      closing ??= new Promise<void>(resolve => {
        closed = true;
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
};
