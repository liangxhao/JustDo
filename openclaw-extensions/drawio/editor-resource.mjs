import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { SaxesParser } from 'saxes';

const URI = 'ui://drawio/editor';
const MIME = 'text/html;profile=mcp-app';
const MAX_XML_BYTES = 1024 * 1024;
const MAX_PORT_ATTEMPTS = 32;
// An OS-assigned port can still be forbidden to the embedded browser (e.g. X11/6000).
// Chromium net/base/port_util.cc plus WHATWG Fetch's additional blocked ports:
// https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/port_util.cc
// https://fetch.spec.whatwg.org/#port-blocking
const BROWSER_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
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

async function listenForBrowser(http) {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        http.removeListener('error', onError);
        http.removeListener('listening', onListening);
      };
      const onError = error => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      http.once('error', onError);
      http.once('listening', onListening);
      try {
        http.listen(0, '127.0.0.1');
      } catch (error) {
        onError(error);
      }
    });
    const address = http.address();
    const valid =
      address &&
      typeof address === 'object' &&
      Number.isInteger(address.port) &&
      address.port >= 0 &&
      address.port <= 65535;
    if (valid && !BROWSER_BLOCKED_PORTS.has(address.port)) return address.port;
    // Do not publish a rejected origin. Finish closing it before allocating again.
    await new Promise((resolve, reject) => {
      http.close(error => (error ? reject(error) : resolve()));
      http.closeAllConnections();
    });
    if (!valid) throw new Error('Offline diagram assets did not receive a valid TCP address.');
  }
  throw new Error('Could not allocate a browser-safe port for offline diagram assets.');
}

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
  const port = await listenForBrowser(http);
  origin = `http://127.0.0.1:${port}`;
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
