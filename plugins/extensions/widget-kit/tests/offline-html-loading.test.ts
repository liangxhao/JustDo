import http from 'node:http';

import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { createOfflineHtmlContentKind } from '../libraries/content-kind';
import { OFFLINE_LIBRARY_RESOURCES } from '../libraries/resources';
import { OFFLINE_LIBRARY_IDS, type OfflineLibraryId } from '../libraries/schema';

const kind = createOfflineHtmlContentKind(new URL('../assets/', import.meta.url));
const readySources: Record<OfflineLibraryId, string> = {
  three: 'globalThis.THREE={WebGLRenderer(){},OrbitControls(){}};',
  echarts: 'globalThis.echarts={init(){}};',
  katex:
    'globalThis.katex={render(){}};globalThis.renderMathInElement=()=>{};globalThis.katexFontsReady=Promise.resolve();',
  mermaid: 'globalThis.mermaid={initialize(){},render(){}};',
  d3: 'globalThis.d3={select(){},scaleLinear(){}};',
  matter: 'globalThis.Matter={Engine:{create(){}},Render:{create(){}}};',
};

async function load(
  libraries: readonly OfflineLibraryId[],
  state: 'missing' | 'empty' | 'partial' | 'ready',
) {
  const errors: string[] = [];
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    const resource = OFFLINE_LIBRARY_RESOURCES.find(resource => resource.path === request.url);
    if (!resource || state === 'missing') {
      response.writeHead(404);
      response.end('private-resource-detail');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(
      state === 'ready'
        ? `globalThis.libraryOrder??=[];globalThis.libraryOrder.push(${JSON.stringify(resource.id)});${readySources[resource.id]}`
        : state === 'partial'
          ? 'globalThis.partialLibrary=true;'
          : '',
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address');
  const html = kind.composeDocument({
    source: JSON.stringify({
      version: 1,
      libraries,
      html: '<div id="authored">Authored content</div><script>globalThis.authorOrder=globalThis.libraryOrder?.slice();</script>',
    }),
    title: 'Offline scene',
    promptGranted: false,
    resourceUrls: Object.fromEntries(
      OFFLINE_LIBRARY_RESOURCES.map(resource => [resource.path, resource.path]),
    ),
  });
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:${address.port}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.addEventListener(
        'error',
        event => {
          if (typeof event.message === 'string' || event.error)
            errors.push(event.error?.message ?? event.message);
          event.preventDefault();
        },
        true,
      );
    },
  });
  await new Promise<void>(resolve =>
    dom.window.addEventListener('load', () => resolve(), { once: true }),
  );
  return {
    dom,
    errors,
    requests,
    async close() {
      dom.window.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('offline library initialization', () => {
  it('makes the requested globals available in order before authored scripts', async () => {
    const libraries = [...OFFLINE_LIBRARY_IDS].reverse();
    const { dom, errors, requests, close } = await load(libraries, 'ready');
    try {
      expect(errors).toEqual([]);
      expect(dom.window.authorOrder).toEqual(libraries);
      expect(requests).toEqual(
        libraries.map(id => OFFLINE_LIBRARY_RESOURCES.find(resource => resource.id === id)!.path),
      );
    } finally {
      await close();
    }
  });

  it.each(OFFLINE_LIBRARY_IDS)('detects a missing, empty or incomplete %s library', async id => {
    for (const state of ['missing', 'empty', 'partial'] as const) {
      const { dom, errors, close } = await load([id], state);
      try {
        expect(errors).toEqual(['Offline widget library initialization failed']);
        expect(dom.window.document.getElementById('authored')?.textContent).toBe(
          'Authored content',
        );
        expect(dom.window.document.body.textContent).not.toContain('private-resource-detail');
      } finally {
        await close();
      }
    }
  });

  it('reports only one fixed initialization failure when several selected resources fail', async () => {
    const { errors, close } = await load(OFFLINE_LIBRARY_IDS, 'missing');
    try {
      expect(errors).toEqual(['Offline widget library initialization failed']);
    } finally {
      await close();
    }
  });
});
