import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { readAppAsset } from './assets';

/** Vite proxies the admitted graph without exposing retained Main code or installation roots. */
export async function startAppDevelopmentAssets(descriptor: string): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'GET' ||
      request.headers['x-app-assets'] !== token ||
      !/^\/assets\/app-plugins\/[a-f0-9]{64}\/[a-zA-Z0-9_-]{1,96}\/[a-zA-Z0-9_./-]+$/u.test(
        request.url ?? '',
      ) ||
      request.url?.includes('..')
    ) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readAppAsset(request.url!.slice(1));
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'Content-Type': request.url!.endsWith('.css')
          ? 'text/css'
          : /\.m?js$/u.test(request.url!)
            ? 'text/javascript'
            : 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('appPluginUnavailable');
  }
  const staged = `${descriptor}.${process.pid}.stage`;
  try {
    await mkdir(path.dirname(descriptor), { recursive: true });
    await writeFile(staged, JSON.stringify({ port: address.port, token }), { mode: 0o600 });
    await rename(staged, descriptor);
  } catch (error) {
    server.close();
    await rm(staged, { force: true });
    throw error;
  }
  return async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      if (JSON.parse(await readFile(descriptor, 'utf8')).token === token)
        await rm(descriptor, { force: true });
    } catch {
      /* A newer app owns its descriptor. */
    }
  };
}
