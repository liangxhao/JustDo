import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { HTML_PAGE_RESOURCE, HTML_PAGE_SURFACE } from './contracts';

type ResourceReader = (
  path: string,
) => Promise<{ body: Uint8Array; contentType: string } | undefined>;

/** Gateway authenticates the scoped capability before this exact route runs. */
export function registerHtmlPageRoute(
  api: Pick<OpenClawPluginApi, 'registerHttpRoute'>,
  read: ResourceReader,
): void {
  api.registerHttpRoute({
    path: HTML_PAGE_RESOURCE,
    match: 'exact',
    auth: 'plugin',
    nodeCapability: { surface: HTML_PAGE_SURFACE },
    async handler(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const raw = req.url ?? '';
      const queryAt = raw.indexOf('?');
      const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
      const query = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
      if (
        pathname !== HTML_PAGE_RESOURCE ||
        raw.includes('#') ||
        [...query.keys()].length !== 1 ||
        !query.has('oc_cap') ||
        !query.get('oc_cap') ||
        query.get('oc_cap')!.length > 4096
      ) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end();
        return true;
      }
      try {
        const resource = await read(HTML_PAGE_RESOURCE);
        if (!resource) throw new Error('Resource unavailable');
        res.statusCode = 200;
        res.setHeader('Content-Type', resource.contentType);
        res.setHeader('Content-Length', resource.body.byteLength);
        res.end(req.method === 'HEAD' ? undefined : resource.body);
      } catch {
        res.statusCode = 503;
        res.end();
      }
      return true;
    },
  });
}
