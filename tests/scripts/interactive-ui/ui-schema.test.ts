import fs from 'node:fs';
import http from 'node:http';
import { Script } from 'node:vm';

import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { scenarioContentKind } from '../../../openclaw-extensions/interactive-ui/scenario/content-kind';
import {
  uiContentKind,
  uiRendererSource,
} from '../../../openclaw-extensions/interactive-ui/ui/content-kind';
import { uiLabels } from '../../../openclaw-extensions/interactive-ui/ui/labels';
import {
  parseUiDocument,
  UI_KIND,
  UI_MAX_NUMBER,
  UI_MAX_SOURCE_BYTES,
  UI_RESOURCE,
  UiSourceError,
} from '../../../openclaw-extensions/interactive-ui/ui/schema';

const table = {
  type: 'table',
  id: 'deliveries',
  title: 'Delivery options',
  columns: [
    { id: 'name', label: 'Option', type: 'text' },
    { id: 'days', label: 'Days', type: 'number' },
  ],
  rows: [
    ['Standard', 7],
    ['Express', 3],
  ],
};
const compare = {
  type: 'compare',
  id: 'choices',
  title: 'Choose a plan',
  metrics: ['Days', 'Cost'],
  items: [
    { id: 'standard', title: 'Standard', values: [7, 200] },
    { id: 'express', title: 'Express', values: [3, 350] },
  ],
};
const chart = {
  type: 'chart',
  id: 'trend',
  title: 'Trend',
  chartType: 'line',
  labels: ['Week 1', 'Week 2'],
  series: [{ id: 'count', label: 'Count', values: [-1.5, 0] }],
};
const form = {
  type: 'form',
  id: 'inputs',
  title: 'Inputs',
  fields: [
    { id: 'topic', label: 'Topic', type: 'text', value: '', required: true },
    { id: 'budget', label: 'Budget', type: 'number', value: null, min: 0, required: true },
    {
      id: 'priority',
      label: 'Priority',
      type: 'select',
      value: 'Normal',
      options: ['Normal', 'Urgent'],
    },
    { id: 'agreed', label: 'Confirmed', type: 'checkbox', value: false, required: true },
  ],
};
const steps = {
  type: 'steps',
  id: 'process',
  title: 'Process',
  items: [{ title: 'Check facts', body: 'Use the supplied data.' }],
};
function source(
  blocks: unknown[] = [table, compare, chart, form, steps],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    language: 'en',
    summary: 'Explore the supplied options',
    blocks,
    ...extra,
  });
}

describe('interactive answer source contract', () => {
  it('accepts one shared document with all five local component types', () => {
    const parsed = parseUiDocument(source());
    expect(parsed.blocks.map(block => block.type)).toEqual([
      'table',
      'compare',
      'chart',
      'form',
      'steps',
    ]);
    expect(parsed.blocks[0]).toEqual(table);
    expect(parsed.blocks[2]).toEqual(chart);
    expect(parsed.blocks[3]).toMatchObject({
      fields: [
        { id: 'topic', value: '', required: true, maxLength: 400 },
        { id: 'budget', value: null, required: true, min: 0 },
        { id: 'priority', value: 'Normal', options: ['Normal', 'Urgent'] },
        { id: 'agreed', value: false, required: true },
      ],
    });
  });

  it('keeps user cell text intact and accepts signed decimal numeric values', () => {
    const parsed = parseUiDocument(
      source([
        {
          ...table,
          rows: [
            ['  quoted input  ', -0.25],
            ['', UI_MAX_NUMBER],
          ],
        },
      ]),
    );
    expect(parsed.blocks[0]).toMatchObject({
      rows: [
        ['  quoted input  ', -0.25],
        ['', UI_MAX_NUMBER],
      ],
    });
  });

  it('normalizes optional form flags without requiring completed user input', () => {
    const parsed = parseUiDocument(
      source([
        {
          ...form,
          fields: [
            { id: 'text', label: 'Text', type: 'text', value: '  ' },
            { id: 'number', label: 'Number', type: 'number', value: null },
            { id: 'checkbox', label: 'Checkbox', type: 'checkbox', value: false },
          ],
        },
      ]),
    );
    expect(parsed.blocks[0]).toMatchObject({
      fields: [
        { value: '  ', required: false, maxLength: 400 },
        { value: null, required: false },
        { value: false, required: false },
      ],
    });
  });

  it('accepts the documented component maxima under the aggregate source budget', () => {
    const maximumTable = {
      ...table,
      columns: Array.from({ length: 8 }, (_, index) => ({
        id: `column-${index}`,
        label: `Column ${index}`,
        type: 'number',
      })),
      rows: Array.from({ length: 100 }, () => Array(8).fill(-UI_MAX_NUMBER)),
    };
    const maximumCompare = {
      ...compare,
      metrics: Array.from({ length: 8 }, (_, index) => `Metric ${index}`),
      items: Array.from({ length: 6 }, (_, index) => ({
        id: `item-${index}`,
        title: `Item ${index}`,
        values: Array(8).fill('Value'),
      })),
    };
    const maximumChart = {
      ...chart,
      labels: Array.from({ length: 40 }, (_, index) => `Point ${index}`),
      series: Array.from({ length: 4 }, (_, index) => ({
        id: `series-${index}`,
        label: `Series ${index}`,
        values: Array(40).fill(UI_MAX_NUMBER),
      })),
    };
    const maximumForm = {
      ...form,
      fields: Array.from({ length: 12 }, (_, index) => ({
        id: `field-${index}`,
        label: `Field ${index}`,
        type: 'text',
        value: 'v'.repeat(400),
      })),
    };
    const maximumSteps = {
      ...steps,
      items: Array.from({ length: 12 }, (_, index) => ({
        title: `Step ${index}`,
        body: 'b'.repeat(400),
      })),
    };
    const input = source([
      maximumTable,
      maximumCompare,
      maximumChart,
      maximumForm,
      maximumSteps,
      { ...table, id: 'table-extra' },
      { ...chart, id: 'chart-extra' },
      { ...steps, id: 'steps-extra' },
    ]);
    expect(new TextEncoder().encode(input).byteLength).toBeLessThan(UI_MAX_SOURCE_BYTES);
    expect(parseUiDocument(input).blocks).toHaveLength(8);
  });

  it.each([
    [{ version: 2 }, 'document.version'],
    [{ language: 'fr' }, 'document.language'],
    [{ summary: ' ' }, 'document.summary'],
    [{ summary: 'a'.repeat(401) }, 'document.summary'],
    [{ note: null }, 'document.note'],
    [{ url: 'https://example.test' }, 'document'],
    [{ blocks: [] }, 'document.blocks'],
    [
      { blocks: Array.from({ length: 9 }, (_, index) => ({ ...table, id: `table-${index}` })) },
      'document.blocks',
    ],
  ])('rejects unsupported document fields and bounds with paths', (extra, errorPath) => {
    expect(() => parseUiDocument(source([table], extra as Record<string, unknown>))).toThrow(
      String(errorPath),
    );
  });

  it.each([
    [{ ...table, url: 'https://example.test' }, 'document.blocks[0]'],
    [{ ...table, id: '../path' }, '.id'],
    [{ ...table, title: 'a'.repeat(81) }, '.title'],
    [{ ...table, columns: [] }, '.columns'],
    [{ ...table, columns: [table.columns[0], table.columns[0]] }, '.columns[1].id'],
    [{ ...table, rows: [] }, '.rows'],
    [{ ...table, rows: Array(101).fill(['x', 1]) }, '.rows'],
    [{ ...table, rows: [['Only one cell']] }, '.rows[0]'],
    [{ ...table, rows: [['Text', '3']] }, '.rows[0][1]'],
    [{ ...table, rows: [[2, 3]] }, '.rows[0][0]'],
    [{ ...table, rows: [['Text', null]] }, '.rows[0][1]'],
    [{ ...table, rows: [['Text', UI_MAX_NUMBER + 1]] }, '.rows[0][1]'],
    [{ ...table, rows: [['a'.repeat(401), 1]] }, '.rows[0][0]'],
    [
      { ...compare, items: [{ ...compare.items[0], values: [1] }, compare.items[1]] },
      '.items[0].values',
    ],
    [{ ...compare, items: [compare.items[0], compare.items[0]] }, '.items[1].id'],
    [
      {
        ...compare,
        items: [{ ...compare.items[0], values: [{ hidden: true }, 1] }, compare.items[1]],
      },
      '.items[0].values[0]',
    ],
    [{ ...chart, chartType: 'pie' }, '.chartType'],
    [{ ...chart, labels: ['One'] }, '.labels'],
    [{ ...chart, series: [{ ...chart.series[0], values: [1] }] }, '.series[0].values'],
    [{ ...chart, series: [chart.series[0], chart.series[0]] }, '.series[1].id'],
    [{ ...chart, series: [{ ...chart.series[0], values: ['1', 2] }] }, '.series[0].values[0]'],
    [{ ...steps, items: [{ ...steps.items[0], script: 'run()' }] }, '.items[0]'],
    [{ ...steps, items: [{ title: 'Title', body: 'a'.repeat(401) }] }, '.items[0].body'],
    [{ ...steps, type: 'html' }, '.type'],
  ])('rejects invalid component data before composition', (block, errorPath) => {
    expect(() => parseUiDocument(source([block]))).toThrow(String(errorPath));
  });

  it.each([
    { id: 'text', label: 'Text', type: 'text', value: '', required: 'yes' },
    { id: 'text', label: 'Text', type: 'text', value: '123', maxLength: 2 },
    { id: 'text', label: 'Text', type: 'text', value: '', maxLength: 2.5 },
    { id: 'text', label: 'Text', type: 'text', value: '', maxLength: 0 },
    { id: 'text', label: 'Text', type: 'text', value: '', min: 0 },
    { id: 'number', label: 'Number', type: 'number', value: '' },
    { id: 'number', label: 'Number', type: 'number', value: 2, min: 3 },
    { id: 'number', label: 'Number', type: 'number', value: null, min: 3, max: 2 },
    { id: 'number', label: 'Number', type: 'number', value: null, max: UI_MAX_NUMBER + 1 },
    { id: 'select', label: 'Select', type: 'select', value: 'X', options: ['A'] },
    { id: 'select', label: 'Select', type: 'select', value: 'A', options: ['A', ' A '] },
    { id: 'select', label: 'Select', type: 'select', value: 'A', options: ['A'], required: true },
    { id: 'checkbox', label: 'Checkbox', type: 'checkbox', value: 1 },
    { id: 'checkbox', label: 'Checkbox', type: 'checkbox', value: false, options: [] },
  ])('rejects impossible form defaults and irrelevant type fields', field => {
    expect(() => parseUiDocument(source([{ ...form, fields: [field] }]))).toThrow(
      'document.blocks[0].fields[0]',
    );
  });

  it('requires unique IDs per scope while allowing IDs in different scopes', () => {
    expect(() => parseUiDocument(source([table, table]))).toThrow('document.blocks[1].id');
    expect(() =>
      parseUiDocument(source([{ ...form, fields: [form.fields[0], form.fields[0]] }])),
    ).toThrow('.fields[1].id');
    expect(() =>
      parseUiDocument(
        source([
          { ...table, id: 'shared' },
          {
            ...form,
            id: 'form',
            fields: [{ id: 'shared', label: 'Name', type: 'text', value: '' }],
          },
        ]),
      ),
    ).not.toThrow();
  });

  it('bounds Unicode bytes before parsing and does not reflect malformed source', () => {
    expect(() => parseUiDocument('中'.repeat(Math.ceil(UI_MAX_SOURCE_BYTES / 3)))).toThrow(
      'source: must not exceed',
    );
    expect(() => parseUiDocument('{"credential": "private-sentinel"')).toThrow(
      'source: expected valid JSON',
    );
    try {
      parseUiDocument(source([table], { 'private-sentinel': 'value' }));
    } catch (error) {
      expect(error).toBeInstanceOf(UiSourceError);
      expect(String(error)).not.toContain('private-sentinel');
      expect(String(error)).toContain('allowed fields');
    }
  });

  it('rejects infinite JSON numbers and prototype/control keys', () => {
    expect(() => parseUiDocument(source([table]).replace('7]', '1e999]'))).toThrow('finite number');
    expect(() =>
      parseUiDocument(source([table]).replace('"version":1', '"version":1,"__proto__":{}')),
    ).toThrow('unexpected field');
    expect(() => parseUiDocument(source([{ ...table, expressions: ['exec()'] }]))).toThrow(
      'unexpected field',
    );
  });

  it('validates every documented native authoring example', () => {
    const skill = fs.readFileSync(
      'openclaw-extensions/interactive-ui/skills/interactive-answer/SKILL.md',
      'utf8',
    );
    const calls = [...skill.matchAll(/```json\s*([\s\S]*?)```/g)].map(
      match => JSON.parse(match[1]) as { kind: string; widget_code: string },
    );
    expect(calls).toHaveLength(5);
    expect(
      calls.map(call => {
        expect(call.kind).toBe(UI_KIND);
        return parseUiDocument(call.widget_code).blocks[0].type;
      }),
    ).toEqual(['table', 'compare', 'chart', 'form', 'steps']);
  });
});

describe('interactive answer native composition', () => {
  async function loadComposedDocument(
    language: 'zh' | 'en',
    resource: 'missing' | 'empty' | 'ready',
  ) {
    const errors: string[] = [];
    const server = http.createServer((request, response) => {
      if (request.url !== UI_RESOURCE || resource === 'missing') {
        response.writeHead(404);
        response.end('private-resource-diagnostic');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(resource === 'ready' ? uiRendererSource() : 'void 0;');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Loopback fixture address missing');
    const html = uiContentKind.composeDocument({
      source: source([table], { language }),
      title: '',
      promptGranted: false,
      resourceUrls: { [UI_RESOURCE]: UI_RESOURCE },
    });
    const dom = new JSDOM(html, {
      url: `http://127.0.0.1:${address.port}/`,
      runScripts: 'dangerously',
      resources: 'usable',
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.addEventListener('error', event => {
          if (event.message) errors.push(event.message);
          event.preventDefault();
        });
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

  it.each(['zh', 'en'] as const)(
    'shows a translated resource failure and emits only a fixed initialization error (%s)',
    async language => {
      const { dom, errors, close } = await loadComposedDocument(language, 'missing');
      try {
        expect(
          dom.window.document.querySelector('#interactive-answer-root [role=alert]')?.textContent,
        ).toBe(uiLabels[language].rendererUnavailable);
        expect(errors).toEqual(['interactive-ui renderer initialization failed']);
        expect(dom.window.document.body.textContent).not.toContain('private-resource-diagnostic');
        expect(dom.window.document.querySelector('#ui-follow')).toBeNull();
      } finally {
        await close();
      }
    },
  );

  it('rejects an empty successful renderer response instead of displaying a blank ready widget', async () => {
    const { dom, errors, close } = await loadComposedDocument('en', 'empty');
    try {
      expect(
        dom.window.document.querySelector('#interactive-answer-root [role=alert]')?.textContent,
      ).toBe(uiLabels.en.rendererUnavailable);
      expect(errors).toEqual(['interactive-ui renderer initialization failed']);
    } finally {
      await close();
    }
  });

  it('accepts the real serialized resource and removes the loading fallback', async () => {
    const { dom, errors, close } = await loadComposedDocument('en', 'ready');
    try {
      expect(dom.window.document.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(dom.window.document.querySelector('#ui-follow')).not.toBeNull();
      expect(dom.window.document.querySelector('#interactive-answer-root [role=alert]')).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  it('embeds source text safely, including script terminators and separators', () => {
    const maliciousText =
      '</script><script>globalThis.injected=true</script>\u2028\u2029plain text';
    const html = uiContentKind.composeDocument({
      source: source([{ ...steps, items: [{ title: 'Text', body: maliciousText }] }], {
        summary: maliciousText,
      }),
      title: 'Host metadata',
      promptGranted: false,
      resourceUrls: { [UI_RESOURCE]: UI_RESOURCE },
    });
    expect(html).not.toContain(maliciousText);
    expect(html).not.toContain('globalThis.injected=true</script>');
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).toContain('id="interactive-answer-root"');
    expect(html).toContain('\\u003c/script>');
    const boot = html.match(/globalThis\.__interactiveAnswerBoot=([^\n]*);\n/)?.[1];
    expect(boot).toBeDefined();
    expect(JSON.parse(boot!)).toMatchObject({
      document: { summary: maliciousText },
      labels: uiLabels.en,
    });
  });

  it('uses a disjoint native public resource and refuses unregistered paths', async () => {
    expect(scenarioContentKind.resources.paths).not.toContain(UI_RESOURCE);
    expect(uiContentKind.resources.paths).toEqual([UI_RESOURCE]);
    expect(await uiContentKind.resources.readPublicResource('/unknown')).toBeUndefined();
    expect(
      await uiContentKind.resources.readPublicResource(`${UI_RESOURCE}?token=private`),
    ).toBeUndefined();
    const resource = await uiContentKind.resources.readPublicResource(UI_RESOURCE);
    expect(resource?.contentType).toBe('text/javascript; charset=utf-8');
    expect(new TextDecoder().decode(resource?.body)).toBe(uiRendererSource());
    expect(() => new Script(uiRendererSource())).not.toThrow();
    expect(() =>
      uiContentKind.composeDocument({
        source: source(),
        title: '',
        promptGranted: false,
        resourceUrls: {},
      }),
    ).toThrow('resource unavailable');
  });

  it('keeps translated keys aligned and composes the selected document language', () => {
    expect(Object.keys(uiLabels.zh).sort()).toEqual(Object.keys(uiLabels.en).sort());
    const html = uiContentKind.composeDocument({
      source: source([steps], { language: 'zh' }),
      title: '',
      promptGranted: false,
      resourceUrls: { [UI_RESOURCE]: UI_RESOURCE },
    });
    const boot = html.match(/globalThis\.__interactiveAnswerBoot=([^\n]*);\n/)?.[1];
    expect(JSON.parse(boot!)).toMatchObject({ labels: uiLabels.zh });
  });
});
