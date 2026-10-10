import http from 'node:http';

import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { scenarioContentKind } from '../../../openclaw-extensions/interactive-ui/scenario/content-kind';
import { scenarioLabels } from '../../../openclaw-extensions/interactive-ui/scenario/labels';
import { uiContentKind } from '../../../openclaw-extensions/interactive-ui/ui/content-kind';
import { uiLabels } from '../../../openclaw-extensions/interactive-ui/ui/labels';

const definitions = [
  {
    definition: scenarioContentKind,
    rootId: 'scenario-explorer-root',
    labels: scenarioLabels,
    source: {
      version: 1,
      summary: 'Synthetic scenario',
      tasks: [{ label: 'Task', hours: 448 }],
      dailyRate: 700,
      budget: 80000,
      deadline: 21,
      people: 6,
      focus: 6,
    },
  },
  {
    definition: uiContentKind,
    rootId: 'interactive-answer-root',
    labels: uiLabels,
    source: {
      version: 1,
      summary: 'Synthetic table',
      blocks: [
        {
          type: 'table',
          id: 'table',
          title: 'Table',
          columns: [{ id: 'value', label: 'Value', type: 'number' }],
          rows: [[1]],
        },
      ],
    },
  },
] as const;
type ResourceState = 'missing' | 'empty' | 'partial' | 'ready';

async function load(
  fixture: (typeof definitions)[number],
  language: 'zh' | 'en',
  state: ResourceState,
) {
  const errors: string[] = [];
  const resourcePath = fixture.definition.resources.paths[0];
  const resource = await fixture.definition.resources.readPublicResource(resourcePath);
  const server = http.createServer((request, response) => {
    if (request.url !== resourcePath || state === 'missing') {
      response.writeHead(404);
      response.end('private-resource-diagnostic');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(
      state === 'ready'
        ? resource!.body
        : state === 'partial'
          ? `document.getElementById(${JSON.stringify(fixture.rootId)}).innerHTML='<button id="ui-follow">Partial renderer</button>';`
          : '',
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address');
  const html = fixture.definition.composeDocument({
    source: JSON.stringify({ ...fixture.source, language }),
    title: 'Synthetic',
    promptGranted: false,
    resourceUrls: { [resourcePath]: resourcePath },
  });
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:${address.port}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      // Match the native bridge's admission of a reportable runtime ErrorEvent.
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
    async close() {
      dom.window.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe.each(definitions)('$definition.kind resource initialization', fixture => {
  it.each(['zh', 'en'] as const)('starts with a disabled follow-up button (%s)', language => {
    const resourcePath = fixture.definition.resources.paths[0];
    const html = fixture.definition.composeDocument({
      source: JSON.stringify({ ...fixture.source, language }),
      title: 'Synthetic',
      promptGranted: false,
      resourceUrls: { [resourcePath]: resourcePath },
    });
    const dom = new JSDOM(html);
    try {
      const follow = dom.window.document.getElementById('follow') as HTMLButtonElement | null;
      expect(follow?.disabled ?? true).toBe(true);
      expect(dom.window.document.querySelector('[role=status]')?.textContent).toBe(
        fixture.labels[language].rendererLoading,
      );
    } finally {
      dom.window.close();
    }
  });

  for (const language of ['zh', 'en'] as const) {
    it.each(['missing', 'empty', 'partial'] as const)(
      `reports %s as a translated fixed failure (${language})`,
      async state => {
        const { dom, errors, close } = await load(fixture, language, state);
        try {
          const root = dom.window.document.getElementById(fixture.rootId)!;
          expect(root.querySelector('[role=alert]')?.textContent).toBe(
            fixture.labels[language].rendererUnavailable,
          );
          expect(root.querySelector('button')).toBeNull();
          expect(root.getAttribute('data-interactive-ui-ready')).not.toBe('true');
          expect(errors).toEqual(['interactive-ui renderer initialization failed']);
          expect(dom.window.document.body.textContent).not.toContain('private-resource-diagnostic');
        } finally {
          await close();
        }
      },
    );

    it(`marks the real renderer ready only after complete initialization (${language})`, async () => {
      const { dom, errors, close } = await load(fixture, language, 'ready');
      try {
        const root = dom.window.document.getElementById(fixture.rootId)!;
        expect(root.getAttribute('data-interactive-ui-ready')).toBe('true');
        expect(root.querySelector('[role=status]')?.textContent).not.toBe(
          fixture.labels[language].rendererLoading,
        );
        expect(root.querySelector('[role=alert]')).toBeNull();
        expect(root.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        const follow = root.querySelector<HTMLButtonElement>('#follow,#ui-follow')!;
        expect(follow.disabled).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
