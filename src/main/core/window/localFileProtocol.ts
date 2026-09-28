import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { net, protocol } from 'electron';

export const registerLocalFileScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'localmedia', privileges: { stream: true, standard: true, secure: true } },
  ]);
};

export const registerLocalFileProtocol = (): void => {
  // Three slashes needed: localfile:///C:/Users/... gives pathname /C:/Users/...
  protocol.handle('localfile', request => {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/([A-Za-z])%3A(?=\/)/i, '/$1:');
    return net.fetch(`file://${url.host}${pathname}`);
  });
  protocol.handle('localmedia', async request => {
    const url = new URL(request.url);
    // Decode only the drive separator; preserve escaped filename characters.
    const pathname = url.pathname.replace(/^\/([A-Za-z])%3A(?=\/)/i, '/$1:');
    if (url.host !== 'local') return new Response(null, { status: 400 });
    const fileUrl = `file://${pathname}`;
    const range = request.headers?.get('Range');
    if (!range) return net.fetch(fileUrl);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
    try {
      const { size } = await stat(fileURLToPath(fileUrl));
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const response = await net.fetch(fileUrl, { method: 'HEAD' });
      const headers = new Headers(response.headers);
      await response.body?.cancel();
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end - start + 1));
      const body = Readable.toWeb(createReadStream(fileURLToPath(fileUrl), { start, end }));
      return new Response(body as ReadableStream<Uint8Array>, { status: 206, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
};
