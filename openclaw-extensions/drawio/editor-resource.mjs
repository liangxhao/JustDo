import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { SaxesParser } from 'saxes';

const URI = 'ui://drawio/editor';
const MIME = 'text/html;profile=mcp-app';
const MAX_XML_BYTES = 1024 * 1024;
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};

/** Read-only, capability-scoped assets. Never exposes diagrams, config, or filesystem APIs. */
export async function startAssets(root) {
  const realRoot = await realpath(root);
  const token = randomBytes(24).toString('hex');
  let origin;
  const http = createServer(async (req, res) => {
    const deny = code => {
      res.writeHead(code);
      res.end();
    };
    try {
      if (req.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(req.method))
        return deny(403);
      const url = new URL(req.url, origin);
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) return deny(404);
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (
        !relative ||
        relative.includes('\\') ||
        relative.split('/').some(part => part === '..' || part.startsWith('.'))
      )
        return deny(404);
      const file = await realpath(path.resolve(realRoot, relative));
      if (!file.startsWith(realRoot + path.sep) || !(await stat(file)).isFile()) return deny(404);
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': `${types[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
        'Content-Length': data.byteLength,
        'Access-Control-Allow-Origin': '*', // Public immutable assets only; opaque MCP sandbox origin.
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'`,
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      deny(404);
    }
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${http.address().port}`;
  return { http, origin, base: `${origin}/${token}/` };
}

export function validateDiagram(args) {
  if (
    !args ||
    typeof args.xml !== 'string' ||
    Buffer.byteLength(args.xml) > MAX_XML_BYTES ||
    !/^\s*(?:<\?xml[^>]*>\s*)?<(?:mxfile|mxGraphModel)\b/.test(args.xml) ||
    /<!DOCTYPE|<!ENTITY/i.test(args.xml)
  ) {
    throw new Error('Expected draw.io mxfile or mxGraphModel XML (maximum 1 MiB, no DTD).');
  }
  const parser = new SaxesParser();
  let depth = 0;
  parser.on('opentag', () => {
    if (++depth > 256) throw new Error('Diagram XML is too deeply nested');
  });
  parser.on('closetag', () => {
    depth--;
  });
  try {
    parser.write(args.xml).close();
  } catch {
    throw new Error('Invalid diagram XML; check closing tags, attributes and escaped labels.');
  }
  return {
    xml: args.xml,
    title: typeof args.title === 'string' ? args.title.slice(0, 160) : 'Diagram',
  };
}

export async function createEditorResource(directory) {
  const assets = await startAssets(path.join(directory, 'public'));
  try {
    const appScript = await readFile(path.join(directory, 'app.js'), 'utf8');
    const css = await readFile(path.join(directory, 'app.css'), 'utf8');
    return {
      close: () => {
        assets.http.closeAllConnections();
        assets.http.close();
      },
      read: async () => {
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="toolbar"><span id="title"></span><span id="status" role="status"></span><button id="save" disabled></button><button id="png" disabled>PNG</button><button id="svg" disabled>SVG</button></div><iframe id="editor" title="draw.io"></iframe><script>window.DIAGRAM_ASSET_BASE=${JSON.stringify(assets.base)};</script><script>${appScript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
        return {
          contents: [
            {
              uri: URI,
              mimeType: MIME,
              text: html,
              _meta: {
                ui: {
                  prefersBorder: false,
                  csp: {
                    resourceDomains: [assets.origin],
                    connectDomains: [assets.origin],
                    frameDomains: [assets.origin],
                  },
                },
              },
            },
          ],
        };
      },
    };
  } catch (error) {
    assets.http.close();
    throw error;
  }
}
