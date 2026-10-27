import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import { htmlPageContentKind, prepareHtmlPageToolCall } from '../document/content-kind';
import {
  HTML_PAGE_KIND,
  HTML_PAGE_PLUGIN_KIND,
  HTML_PAGE_RESOURCE,
  HTML_PAGE_SURFACE,
} from '../document/contracts';
import { registerHtmlPageRoute } from '../document/http-route';

const compose = (source: string, url = HTML_PAGE_RESOURCE) =>
  htmlPageContentKind.composeDocument({
    source,
    title: 'Synthetic page',
    promptGranted: false,
    resourceUrls: { [HTML_PAGE_RESOURCE]: url },
  });

describe('HTML page native network admission', () => {
  const source =
    '<script type="module">' +
    'import "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";' +
    'const texture = name => `https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/textures/planets/${name}`;' +
    '</script><img src="https://images.example:8443/earth.jpg">';
  const call = (params: Record<string, unknown>) =>
    prepareHtmlPageToolCall({
      toolName: 'show_widget',
      params: { kind: 'html-page', widget_code: source, ...params },
    });

  it('fills omitted pin and exact origins while preserving the complete authored source', () => {
    const params = { kind: 'html-page', title: 'Earth', name: 'earth', widget_code: source };
    const result = prepareHtmlPageToolCall({ toolName: 'show_widget', params });
    expect(result?.params).toEqual({
      ...params,
      pin: true,
      capabilities: {
        netOrigins: ['https://cdn.jsdelivr.net', 'https://images.example:8443'],
      },
    });
    expect(params).not.toHaveProperty('pin');
    expect(params).not.toHaveProperty('capabilities');
  });

  it('preserves explicit origins and other native capabilities', () => {
    const capabilities = { netOrigins: ['https://declared.example'], tools: ['prompt'] };
    expect(call({ capabilities })?.params).toMatchObject({ pin: true, capabilities });
    expect(call({ capabilities: { tools: ['prompt'] } })?.params).toMatchObject({
      capabilities: {
        tools: ['prompt'],
        netOrigins: ['https://cdn.jsdelivr.net', 'https://images.example:8443'],
      },
    });
  });

  it.each([false, null, 'true'])(
    'keeps explicit pin=%s for native validation without adding declarations',
    pin => {
      expect(call({ pin })).toBeUndefined();
    },
  );

  it.each([null, [], { netOrigins: [] }, { netOrigins: null }, { netOrigins: 'invalid' }])(
    'does not repair or expand explicitly supplied capabilities %j',
    capabilities => {
      expect(call({ capabilities })).toBeUndefined();
    },
  );

  it('leaves local sources, other kinds and other tools unchanged', () => {
    expect(call({ widget_code: '<p>Local page</p>' })).toBeUndefined();
    expect(
      call({ widget_code: '<script>const url = `https://${host}/image.jpg`;</script>' }),
    ).toBeUndefined();
    expect(call({ widget_code: '<!-- See https://docs.example). -->' })).toBeUndefined();
    expect(call({ kind: 'html' })).toBeUndefined();
    expect(
      prepareHtmlPageToolCall({
        toolName: 'tool_call',
        params: { kind: 'html-page', widget_code: source },
      }),
    ).toBeUndefined();
  });
});

describe('raw HTML page composition', () => {
  it('registers a raw source kind with one functional adapter resource', async () => {
    expect(htmlPageContentKind.kind).toBe(HTML_PAGE_KIND);
    expect(HTML_PAGE_PLUGIN_KIND).toBe(`smart-canvas:${HTML_PAGE_KIND}`);
    expect(htmlPageContentKind.resources).toMatchObject({
      surface: HTML_PAGE_SURFACE,
      paths: [HTML_PAGE_RESOURCE],
    });
    const resource = await htmlPageContentKind.resources.readPublicResource(HTML_PAGE_RESOURCE);
    expect(resource?.contentType).toBe('text/javascript; charset=utf-8');
    expect(new TextDecoder().decode(resource?.body)).toContain('HTMLImageElement.prototype');
    expect(
      await htmlPageContentKind.resources.readPublicResource('/not-the-adapter.js'),
    ).toBeUndefined();
  });

  it('accepts raw fragment and complete HTML without a JSON envelope or plugin size ceiling', () => {
    for (const source of [
      '<p>Fragment</p>',
      '<!doctype html><html><head><title>Page</title></head><body>Page</body></html>',
      '<p>' + '汉'.repeat(262_144) + '</p>',
    ])
      expect(() => htmlPageContentKind.validateSource(source)).not.toThrow();
    for (const source of ['', ' \n\t', undefined, null, 1, {}])
      expect(() => htmlPageContentKind.validateSource(source as string)).toThrow(
        'Expected non-empty HTML source',
      );
  });

  it('keeps authored fragments and imports after the blocking classic adapter', () => {
    const source =
      '<style>#scene{height:200px}</style><div id="scene"></div>' +
      '<script type="importmap">{"imports":{"scene":"https://cdn.jsdelivr.net/scene.js"}}</script>' +
      '<script type="module">import "scene";</script>';
    const output = compose(source);
    expect(output.endsWith(source)).toBe(true);
    const dom = new JSDOM(output);
    try {
      const scripts = [...dom.window.document.querySelectorAll('script')];
      expect(scripts[1].getAttribute('src')).toBe(HTML_PAGE_RESOURCE);
      for (const name of ['type', 'async', 'defer', 'crossorigin'])
        expect(scripts[1].hasAttribute(name)).toBe(false);
      expect(scripts[2].type).toBe('importmap');
      expect(scripts[3].type).toBe('module');
    } finally {
      dom.window.close();
    }
  });

  it('normalizes the complete document and escapes only the adapter URL', () => {
    const output = compose(
      '<!doctype html><html lang="zh"><head><style>body{color:red}</style></head>' +
        '<body class="scene"><img id="earth" src="https://images.example/earth.png">' +
        '<script>window.authorOrder = 1;</script></body></html>',
      'https://gateway.example/__openclaw__/cap/synthetic/image.js?a=1&b="quoted"',
    );
    expect(output).not.toMatch(/<!doctype|<html|<head|<body/i);
    const dom = new JSDOM(output);
    try {
      const image = dom.window.document.querySelector('img')!;
      expect(image.hasAttribute('src')).toBe(false);
      expect(image.getAttribute('data-smart-canvas-asset-src')).toBe('https://images.example/earth.png');
      expect(dom.window.document.querySelector('script[src]')!.getAttribute('src')).toBe(
        'https://gateway.example/__openclaw__/cap/synthetic/image.js?a=1&b="quoted"',
      );
      expect(output).toContain('"target":"html"');
      expect(output).toContain('"target":"body"');
    } finally {
      dom.window.close();
    }
    expect(() =>
      htmlPageContentKind.composeDocument({
        source: '<p>Page</p>',
        title: 'Page',
        promptGranted: false,
        resourceUrls: {},
      }),
    ).toThrow('Widget image loading resource unavailable');
  });
});

async function loadAdapter(state: 'ready' | 'missing' | 'empty') {
  const resource = await htmlPageContentKind.resources.readPublicResource(HTML_PAGE_RESOURCE);
  const errors: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.url !== HTML_PAGE_RESOURCE || state === 'missing') {
      response.writeHead(404).end('private-network-diagnostic');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(state === 'empty' ? '' : resource!.body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback test server');
  const dom = new JSDOM(
    compose(
      '<script>window.adapterBeforeAuthor=Object.prototype.hasOwnProperty.call(' +
        'HTMLImageElement.prototype,Symbol.for("smart-canvas.image-loading"));</script>',
    ),
    {
      url: `http://127.0.0.1:${address.port}/`,
      runScripts: 'dangerously',
      resources: 'usable',
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.addEventListener('error', event => {
          if (typeof event.message === 'string' || event.error)
            errors.push(event.error?.message ?? event.message);
          event.preventDefault();
        });
      },
    },
  );
  await new Promise<void>(resolve =>
    dom.window.addEventListener('load', () => resolve(), { once: true }),
  );
  return {
    dom,
    errors,
    async close() {
      dom.window.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('HTML image adapter resource loading', () => {
  it('installs the real adapter before the first author script', async () => {
    const { dom, errors, close } = await loadAdapter('ready');
    try {
      expect(dom.window.adapterBeforeAuthor).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  it.each(['missing', 'empty'] as const)(
    'reports a fixed runtime error for %s resources',
    async state => {
      const { dom, errors, close } = await loadAdapter(state);
      try {
        expect(dom.window.adapterBeforeAuthor).toBe(false);
        expect(errors).toEqual(['Widget image loading initialization failed']);
      } finally {
        await close();
      }
    },
  );
});

type Route = {
  path: string;
  match?: string;
  auth: string;
  nodeCapability?: { surface: string };
  handler: (request: IncomingMessage, response: ServerResponse) => unknown;
};

function routeFixture() {
  const routes: Route[] = [];
  const body = new TextEncoder().encode('/* Synthetic functional resource */');
  const read = vi.fn(async () => ({ body, contentType: 'text/javascript; charset=utf-8' }));
  registerHtmlPageRoute({ registerHttpRoute: route => routes.push(route) }, read);
  const request = async (url: string, method = 'GET') => {
    const headers = new Map<string, unknown>();
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: unknown) => headers.set(name, value),
      end: vi.fn(),
    };
    await routes[0].handler(
      { url, method } as IncomingMessage,
      response as unknown as ServerResponse,
    );
    return { ...response, headers };
  };
  return { routes, read, body, request };
}

describe('HTML image adapter native capability route', () => {
  it('registers one exact route and serves its functional bytes', async () => {
    const { routes, body, read, request } = routeFixture();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: HTML_PAGE_RESOURCE,
      match: 'exact',
      auth: 'plugin',
      nodeCapability: { surface: HTML_PAGE_SURFACE },
    });
    const response = await request(`${HTML_PAGE_RESOURCE}?oc_cap=synthetic`);
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(body.byteLength);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.end).toHaveBeenCalledWith(body);
    expect(read).toHaveBeenCalledExactlyOnceWith(HTML_PAGE_RESOURCE);
  });

  it('supports HEAD without sending a body', async () => {
    const { request, read } = routeFixture();
    const response = await request(`${HTML_PAGE_RESOURCE}?oc_cap=synthetic`, 'HEAD');
    expect(response.statusCode).toBe(200);
    expect(response.end).toHaveBeenCalledWith(undefined);
    expect(read).toHaveBeenCalledExactlyOnceWith(HTML_PAGE_RESOURCE);
  });

  it('rejects unscoped, unrelated and malformed requests without reading a resource', async () => {
    const { request, read } = routeFixture();
    for (const candidate of [
      HTML_PAGE_RESOURCE,
      `${HTML_PAGE_RESOURCE}?oc_cap=`,
      `${HTML_PAGE_RESOURCE}?oc_cap=a&oc_cap=b`,
      `${HTML_PAGE_RESOURCE}?oc_cap=a&other=b`,
      `${HTML_PAGE_RESOURCE}?oc_cap=a#fragment`,
      `${HTML_PAGE_RESOURCE}/other?oc_cap=a`,
      '/__smart_canvas__/libraries/three.js?oc_cap=a',
    ])
      expect((await request(candidate)).statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves unsupported methods unread and hides resource failures', async () => {
    const { request, read } = routeFixture();
    expect((await request(`${HTML_PAGE_RESOURCE}?oc_cap=a`, 'POST')).statusCode).toBe(405);
    expect(read).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(new Error('private-resource-diagnostic'));
    const response = await request(`${HTML_PAGE_RESOURCE}?oc_cap=a`);
    expect(response.statusCode).toBe(503);
    expect(response.end).toHaveBeenCalledExactlyOnceWith();
  });
});
