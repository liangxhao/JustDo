import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';

/** Preserve the renderer's existing development origin and CSP. */
export function appPluginAssetsPlugin(projectRoot) {
  return {
    name: 'app-plugin-assets',
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        if (!incoming.url?.startsWith('/assets/app-plugins/')) {
          next();
          return;
        }
        // Vite rewrites variable dynamic imports to append this fixed marker.
        // The private Main asset host receives only the validated immutable path.
        const assetPath = incoming.url.endsWith('?import')
          ? incoming.url.slice(0, -'?import'.length)
          : incoming.url;
        if (
          incoming.method !== 'GET' ||
          !/^\/assets\/app-plugins\/[a-f0-9]{64}\/[a-zA-Z0-9_-]{1,96}\/[a-zA-Z0-9_./-]+$/u.test(
            assetPath,
          ) ||
          incoming.url.includes('..')
        ) {
          outgoing.writeHead(404).end();
          return;
        }
        try {
          const descriptor = JSON.parse(
            await readFile(
              path.join(projectRoot, 'build/app-plugins/development-assets.json'),
              'utf8',
            ),
          );
          if (
            !Number.isInteger(descriptor.port) ||
            descriptor.port < 1 ||
            descriptor.port > 65535 ||
            !/^[a-f0-9]{64}$/u.test(descriptor.token)
          )
            throw new Error('Invalid asset host');
          const proxy = request(
            {
              hostname: '127.0.0.1',
              port: descriptor.port,
              path: assetPath,
              method: 'GET',
              headers: { 'x-app-assets': descriptor.token },
              timeout: 3000,
            },
            response => {
              outgoing.writeHead(response.statusCode ?? 404, {
                'Content-Type': response.headers['content-type'] ?? 'application/octet-stream',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
              });
              response.pipe(outgoing);
            },
          );
          proxy.on('timeout', () => proxy.destroy());
          proxy.on('error', () => {
            if (!outgoing.headersSent) outgoing.writeHead(404);
            outgoing.end();
          });
          incoming.on('aborted', () => proxy.destroy());
          proxy.end();
        } catch {
          outgoing.writeHead(404).end();
        }
      });
    },
  };
}
