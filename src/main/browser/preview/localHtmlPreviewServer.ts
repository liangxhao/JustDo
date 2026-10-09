import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

import type { BrowserLocalHtmlPreviewResult } from '../../../shared/browser/browser';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_PREVIEWS = 1_024;
const HTML_EXTENSIONS = new Set(['.htm', '.html', '.xhtml']);
const WEB_ASSET_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.gif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.txt',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
  '.xhtml',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
};

interface HtmlPreviewRoot {
  entryPath: string;
  entryName: string;
  rootPath: string;
}

interface LocalHtmlPreviewServer {
  port: number;
  server: http.Server;
}

const previews = new Map<string, HtmlPreviewRoot>();
const previewTokensByEntryPath = new Map<string, string>();
let serverPromise: Promise<LocalHtmlPreviewServer> | null = null;
let serverPort: number | null = null;

const previewTokenFromUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== LOOPBACK_HOST ||
      serverPort === null ||
      Number(url.port) !== serverPort
    ) {
      return null;
    }
    const token = url.pathname.split('/').filter(Boolean)[0];
    return token && previews.has(token) ? token : null;
  } catch {
    return null;
  }
};

export const isLocalHtmlPreviewUrl = (url: string): boolean => previewTokenFromUrl(url) !== null;

export const isSameLocalHtmlPreviewScope = (sourceUrl: string, targetUrl: string): boolean => {
  const sourceToken = previewTokenFromUrl(sourceUrl);
  const targetToken = previewTokenFromUrl(targetUrl);
  return sourceToken !== null && sourceToken === targetToken;
};

export const isAllowedLocalHtmlPreviewResource = (
  sourceUrl: string,
  targetUrl: string,
): boolean => {
  if (isSameLocalHtmlPreviewScope(sourceUrl, targetUrl)) return true;
  try {
    const target = new URL(targetUrl);
    if (target.protocol === 'data:') return true;
    return target.protocol === 'blob:' && target.origin === new URL(sourceUrl).origin;
  } catch {
    return false;
  }
};

export const isWindowsNetworkOrDevicePath = (
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean => platform === 'win32' && /^[\\/]{2}/u.test(filePath);

export const resolveLocalHtmlPreviewFilePath = async (rawUrl: string): Promise<string | null> => {
  try {
    const token = previewTokenFromUrl(rawUrl);
    const preview = token ? previews.get(token) : undefined;
    if (!token || !preview) return null;
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments.shift() !== token) return null;
    const relativePath = segments.length > 0 ? segments.join(path.sep) : preview.entryName;
    if (
      relativePath.split(/[\\/]/u).some(segment => segment.startsWith('.')) ||
      !HTML_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    ) {
      return null;
    }
    const candidatePath = path.resolve(preview.rootPath, relativePath);
    if (!isWithinRoot(preview.rootPath, candidatePath)) return null;
    const realPath = await fs.promises.realpath(candidatePath);
    if (!isWithinRoot(preview.rootPath, realPath)) return null;
    const stats = await fs.promises.lstat(realPath);
    return stats.isFile() && !stats.isSymbolicLink() ? realPath : null;
  } catch {
    return null;
  }
};

const isWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const respondNotFound = (response: http.ServerResponse): void => {
  response.writeHead(404, { 'Cache-Control': 'no-store' });
  response.end('Not found');
};

const handleRequest = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> => {
  try {
    const requestUrl = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    const segments = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const token = segments.shift();
    const preview = token ? previews.get(token) : undefined;
    if (!preview && request.method === 'GET') {
      const referrerToken = request.headers.referer
        ? previewTokenFromUrl(request.headers.referer)
        : null;
      if (referrerToken && requestUrl.pathname.startsWith('/')) {
        response.writeHead(307, {
          'Cache-Control': 'no-store',
          Location: `/${referrerToken}${requestUrl.pathname}${requestUrl.search}`,
        });
        response.end();
        return;
      }
    }
    if (!preview || request.method !== 'GET') {
      respondNotFound(response);
      return;
    }
    previews.delete(token!);
    previews.set(token!, preview);

    const relativePath = segments.length > 0 ? segments.join(path.sep) : preview.entryName;
    if (
      relativePath.split(/[\\/]/u).some(segment => segment.startsWith('.')) ||
      !WEB_ASSET_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    ) {
      respondNotFound(response);
      return;
    }

    const candidatePath = path.resolve(preview.rootPath, relativePath);
    if (!isWithinRoot(preview.rootPath, candidatePath)) {
      respondNotFound(response);
      return;
    }
    const realPath = await fs.promises.realpath(candidatePath);
    if (!isWithinRoot(preview.rootPath, realPath)) {
      respondNotFound(response);
      return;
    }
    const stats = await fs.promises.lstat(realPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      respondNotFound(response);
      return;
    }

    const extension = path.extname(realPath).toLowerCase();
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Content-Security-Policy':
        "default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' data:; worker-src 'self' blob:; form-action 'none'; frame-src 'self' data: blob:; object-src 'none'; base-uri 'self'",
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(fs.createReadStream(realPath), response);
  } catch {
    if (response.headersSent) response.destroy();
    else respondNotFound(response);
  }
};

const ensureServer = (): Promise<LocalHtmlPreviewServer> => {
  if (serverPromise) return serverPromise;
  serverPromise = new Promise<LocalHtmlPreviewServer>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      void handleRequest(request, response);
    });
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to start the local HTML preview server'));
        return;
      }
      server.unref();
      serverPort = address.port;
      resolve({ port: address.port, server });
    });
  }).catch(error => {
    serverPromise = null;
    serverPort = null;
    throw error;
  });
  return serverPromise;
};

export const createLocalHtmlPreview = async (
  filePath: string,
  workingDirectory?: string,
): Promise<BrowserLocalHtmlPreviewResult> => {
  try {
    const trimmedPath = filePath.trim();
    if (isWindowsNetworkOrDevicePath(trimmedPath)) {
      return { success: false, errorCode: 'invalid_source' };
    }
    let resolvedPath: string;
    if (/^file:/iu.test(trimmedPath)) {
      const fileUrl = new URL(trimmedPath);
      if (fileUrl.hostname) return { success: false, errorCode: 'invalid_source' };
      resolvedPath = fileURLToPath(fileUrl);
    } else {
      resolvedPath = path.resolve(workingDirectory?.trim() || process.cwd(), trimmedPath);
    }
    if (isWindowsNetworkOrDevicePath(resolvedPath)) {
      return { success: false, errorCode: 'invalid_source' };
    }
    if (!HTML_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
      return { success: false, errorCode: 'invalid_type' };
    }
    const stats = await fs.promises.lstat(resolvedPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { success: false, errorCode: 'invalid_source' };
    }
    const realPath = await fs.promises.realpath(resolvedPath);
    const rootPath = await fs.promises.realpath(path.dirname(realPath));
    const { port } = await ensureServer();
    const existingToken = previewTokensByEntryPath.get(realPath);
    const token =
      existingToken && previews.has(existingToken)
        ? existingToken
        : crypto.randomBytes(24).toString('base64url');
    previews.delete(token);
    previews.set(token, { entryPath: realPath, entryName: path.basename(realPath), rootPath });
    previewTokensByEntryPath.set(realPath, token);
    while (previews.size > MAX_PREVIEWS) {
      const oldest = previews.entries().next().value as [string, HtmlPreviewRoot] | undefined;
      if (!oldest) break;
      previews.delete(oldest[0]);
      if (previewTokensByEntryPath.get(oldest[1].entryPath) === oldest[0]) {
        previewTokensByEntryPath.delete(oldest[1].entryPath);
      }
    }
    const previewRootUrl = `http://${LOOPBACK_HOST}:${port}/${token}/`;
    return {
      success: true,
      url: `${previewRootUrl}${encodeURIComponent(path.basename(realPath))}`,
      filePath: realPath,
      rootPath,
      previewRootUrl,
    };
  } catch (error) {
    const notFound = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return {
      success: false,
      errorCode: notFound ? 'not_found' : 'failed',
    };
  }
};
