// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uiLabels } from '../../../openclaw-extensions/interactive-ui/ui/labels';
import { uiRuntime } from '../../../openclaw-extensions/interactive-ui/ui/runtime';
import {
  parseUiDocument,
  type UiDocument,
} from '../../../openclaw-extensions/interactive-ui/ui/schema';
import { uiStyles } from '../../../openclaw-extensions/interactive-ui/ui/styles';

type HostWindow = typeof globalThis & { openclaw?: { prompt: { send: ReturnType<typeof vi.fn> } } };
const host = globalThis as HostWindow;
const table = {
  type: 'table',
  id: 'table',
  title: 'Inventory',
  columns: [
    { id: 'name', label: 'Name', type: 'text' },
    { id: 'count', label: 'Count', type: 'number' },
  ],
  rows: [
    ['zero', 0],
    ['ten', 10],
    ['two', 2],
    ['two-next', 2],
    ['three', 3],
    ['outside', 9],
    ['target', 100],
  ],
};
const form = {
  type: 'form',
  id: 'form',
  title: 'Requirements',
  fields: [
    { id: 'goal', label: 'Goal', type: 'text', value: '', required: true },
    {
      id: 'budget',
      label: 'Budget',
      type: 'number',
      value: null,
      required: true,
      min: -10,
      max: 100,
    },
    { id: 'optional', label: 'Optional', type: 'number', value: null },
    { id: 'choice', label: 'Choice', type: 'select', value: 'A', options: ['A', 'B'] },
    { id: 'agree', label: 'Agree', type: 'checkbox', value: false, required: true },
  ],
};
let trustedHandler: (event: Event) => void;
let send: ReturnType<typeof vi.fn>;
let runtimeListeners: { type: string; listener: EventListener }[];

function mount(blocks: unknown[], language: 'zh' | 'en' = 'en', summary = 'Answer'): UiDocument {
  const doc = parseUiDocument(JSON.stringify({ version: 1, language, summary, blocks }));
  uiRuntime({ document: doc, labels: uiLabels[language] });
  return doc;
}
function panel(id: string): HTMLElement {
  return document.getElementById(`ui_${id}_panel`)!;
}
function field(id: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return document.getElementById(`ui_form_field_${id}`) as HTMLInputElement;
}
function edit(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function fullSelection(): { blocks: { id: string; values: { id: string; value: unknown }[] }[] } {
  return JSON.parse((document.getElementById('ui-full-values') as HTMLTextAreaElement).value);
}
function policy(available = true, source: MessageEventSource = window.parent) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      data: { type: 'openclaw:scenario-draft-policy', available },
    }),
  );
}
function clickTrustedHandler() {
  // jsdom cannot fabricate native activation. Invoke the installed handler to
  // test its trusted branch; actual browser activation has a separate native gate.
  trustedHandler({ isTrusted: true } as Event);
}

beforeEach(() => {
  document.body.innerHTML = '<main id="interactive-answer-root"></main>';
  send = vi.fn(() => true);
  host.openclaw = { prompt: { send } };
  runtimeListeners = [];
  const addWindow = window.addEventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation(function (
    this: Window,
    type,
    listener,
    options,
  ) {
    if ((type === 'message' || type === 'pagehide') && typeof listener === 'function')
      runtimeListeners.push({ type, listener });
    return addWindow.call(this, type, listener, options);
  });
  const addButton = HTMLButtonElement.prototype.addEventListener;
  vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(function (
    this: HTMLButtonElement,
    type,
    listener,
    options,
  ) {
    if (this.id === 'ui-follow' && type === 'click' && typeof listener === 'function')
      trustedHandler = event => listener.call(this, event);
    return addButton.call(this, type, listener, options);
  });
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  runtimeListeners.forEach(({ type, listener }) => window.removeEventListener(type, listener));
  delete host.openclaw;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('controlled UI table and panel interaction', () => {
  it('paginates five rows and searches the complete source without mutating data', () => {
    const doc = mount([table]);
    const search = panel('table').querySelector<HTMLInputElement>('input[type=search]')!;
    expect(panel('table').querySelectorAll('tbody tr')).toHaveLength(5);
    panel('table').querySelectorAll<HTMLButtonElement>('.ui-pager button')[1].click();
    expect(panel('table').querySelector('tbody')!.textContent).toContain('outside');
    edit(search, 'target');
    expect(panel('table').querySelectorAll('tbody tr')).toHaveLength(1);
    expect(panel('table').querySelector('tbody')!.textContent).toContain('100');
    edit(search, 'not-found');
    expect(panel('table').querySelector('tbody')!.textContent).toBe(uiLabels.en.noResults);
    expect(doc.blocks[0]).toMatchObject({ rows: table.rows });
  });

  it('sorts numbers stably, exposes header state and keeps the search focus', () => {
    mount([table]);
    const search = panel('table').querySelector<HTMLInputElement>('input[type=search]')!;
    search.focus();
    edit(search, 'two');
    expect(document.activeElement).toBe(search);
    edit(search, '');
    const headers = panel('table').querySelectorAll('thead th');
    headers[1].querySelector<HTMLButtonElement>('button')!.click();
    expect(headers[1].getAttribute('aria-sort')).toBe('ascending');
    expect(
      [...panel('table').querySelectorAll('tbody tr')].map(
        row => row.querySelector('td')!.textContent,
      ),
    ).toEqual(['zero', 'two', 'two-next', 'three', 'outside']);
    headers[1].querySelector<HTMLButtonElement>('button')!.click();
    expect(headers[1].getAttribute('aria-sort')).toBe('descending');
    expect(panel('table').querySelector('tbody tr td')!.textContent).toBe('target');
  });

  it('shows a single full row as text and keeps its activating button', () => {
    const text = '<img src=x onerror=alert(1)>' + 'a'.repeat(200);
    mount([
      {
        ...table,
        rows: [
          [text, 2],
          ['another', 3],
        ],
      },
    ]);
    const row = panel('table').querySelector<HTMLButtonElement>('button[data-row="0"]')!;
    row.focus();
    row.click();
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(panel('table').querySelector('.ui-details')!.textContent).toContain(text);
    expect(panel('table').querySelector('img')).toBeNull();
    panel('table').querySelector<HTMLButtonElement>('button[data-row="1"]')!.click();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(panel('table').querySelector('.ui-details')!.textContent).not.toContain(text);
    expect(fullSelection().blocks[0].values.find(value => value.id === 'row')!.value).toBe(2);
    expect(JSON.stringify(fullSelection())).not.toContain(text);
  });

  it('switches components without resetting inputs, searches or selections', () => {
    mount([table, form]);
    const switches = document.querySelectorAll<HTMLButtonElement>('.ui-nav button');
    edit(panel('table').querySelector<HTMLInputElement>('input[type=search]')!, 'two');
    switches[1].click();
    edit(field('goal'), 'Keep this\nmultiline goal');
    expect(panel('table').hidden).toBe(true);
    switches[0].click();
    expect(panel('table').querySelector<HTMLInputElement>('input[type=search]')!.value).toBe('two');
    switches[1].click();
    expect(field('goal').value).toBe('Keep this\nmultiline goal');
    expect(switches[1].getAttribute('aria-pressed')).toBe('true');
  });
});

describe('comparison, chart and explanation components', () => {
  it('does not recommend an option automatically and shows all selected metric values', () => {
    const long = 'Complete value '.repeat(20);
    mount([
      {
        type: 'compare',
        id: 'compare',
        title: 'Choose',
        metrics: ['Cost', 'Details'],
        items: [
          { id: 'a', title: 'A', values: [10, long] },
          { id: 'b', title: 'B', values: [20, 'Other'] },
        ],
      },
    ]);
    const options = panel('compare').querySelectorAll<HTMLButtonElement>('.ui-options button');
    expect([...options].every(option => option.getAttribute('aria-pressed') === 'false')).toBe(
      true,
    );
    options[0].click();
    expect(options[0].getAttribute('aria-pressed')).toBe('true');
    expect(panel('compare').querySelector('.ui-compare')!.textContent).toContain(long);
    expect(fullSelection().blocks[0].values.find(value => value.id === 'selected')!.value).toBe(
      'a',
    );
  });

  it.each(['table', 'compare'])(
    'keeps maximum %s values complete while expanding only one full-width detail',
    kind => {
      const value = '长'.repeat(400);
      const labels = Array.from({ length: 8 }, (_, index) => `${index}` + '指'.repeat(79));
      const block =
        kind === 'table'
          ? {
              type: 'table',
              id: 'maximum',
              title: 'Maximum row',
              columns: labels.map((label, index) => ({
                id: `column-${index}`,
                label,
                type: 'text',
              })),
              rows: [labels.map(() => value)],
            }
          : {
              type: 'compare',
              id: 'maximum',
              title: 'Maximum comparison',
              metrics: labels,
              items: Array.from({ length: 6 }, (_, index) => ({
                id: `option-${index}`,
                title: `${index}` + '方'.repeat(79),
                values: labels.map(() => value),
              })),
            };
      const doc = mount([block], 'zh');
      const activate = panel('maximum').querySelector<HTMLButtonElement>(
        kind === 'table' ? 'button[data-row]' : '.ui-options button',
      )!;
      activate.click();
      const values = panel('maximum').querySelector<HTMLElement>(
        kind === 'table' ? '.ui-details' : '.ui-compare',
      )!;
      const details = [...values.querySelectorAll<HTMLDetailsElement>('details')];
      expect(details).toHaveLength(8);
      expect(details.every(detail => !detail.open)).toBe(true);
      expect(new Set(details.map(detail => detail.getAttribute('name'))).size).toBe(1);
      details.forEach(detail => {
        expect(detail.querySelector('summary')!.textContent).toBe(uiLabels.zh.fullValue);
        expect(detail.querySelector('summary')!.getAttribute('aria-label')).toBeTruthy();
        expect(detail.querySelector('p')!.textContent).toBe(value);
      });
      const selection = fullSelection();
      details[0].open = true;
      details[0].dispatchEvent(new Event('toggle'));
      details[1].open = true;
      details[1].dispatchEvent(new Event('toggle'));
      expect(details.map(detail => detail.open)).toEqual([
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(fullSelection()).toEqual(selection);
      expect(doc.blocks[0]).toMatchObject(block);
      if (kind === 'table') {
        activate.click();
        activate.click();
      } else panel('maximum').querySelectorAll<HTMLButtonElement>('.ui-options button')[1].click();
      expect(
        [...values.querySelectorAll<HTMLDetailsElement>('details')].every(detail => !detail.open),
      ).toBe(true);
    },
  );

  it('retains legal multiline source values without forcing hundreds of rendered empty lines', () => {
    const value = 'Start\n' + '\n'.repeat(385) + 'End';
    mount([
      {
        type: 'compare',
        id: 'compare',
        title: 'Multiline values',
        metrics: ['Text'],
        items: [
          { id: 'a', title: 'A', values: [value] },
          { id: 'b', title: 'B', values: ['Short'] },
        ],
      },
    ]);
    panel('compare').querySelector<HTMLButtonElement>('.ui-options button')!.click();
    const detail = panel('compare').querySelector<HTMLDetailsElement>('.ui-value-detail')!;
    detail.open = true;
    detail.dispatchEvent(new Event('toggle'));
    expect(detail.querySelector('p')!.textContent).toBe(value);
    expect(fullSelection().blocks[0].values.find(entry => entry.id === 'metric-0')!.value).toBe(
      value,
    );
    // Complete values flow as ordinary text; explicit whitespace formatting is
    // reserved for the bounded readonly copy box, avoiding blank-line height.
    expect(uiStyles).not.toMatch(/white-space:pre-wrap/);
  });

  it.each(['line', 'bar'])(
    'renders %s with negative/zero data and accessible full data while series are hidden',
    chartType => {
      mount([
        {
          type: 'chart',
          id: 'chart',
          title: 'Trend',
          chartType,
          labels: ['Long label '.repeat(5), 'B', 'C'],
          series: [
            { id: 'one', label: 'One', values: [-10, 0, 5] },
            { id: 'two', label: 'Two', values: [0, 0, 0] },
          ],
        },
      ]);
      const svg = panel('chart').querySelector('svg')!;
      expect(svg.getAttribute('aria-labelledby')).toBeTruthy();
      expect(svg.outerHTML).not.toMatch(/NaN|Infinity/);
      expect(panel('chart').querySelector('tbody')!.textContent).toContain('-10');
      expect(panel('chart').querySelector('tbody')!.textContent).toContain(
        'Long label '.repeat(5).trim(),
      );
      const toggles = panel('chart').querySelectorAll<HTMLButtonElement>('.ui-legend button');
      toggles[0].click();
      toggles[1].click();
      expect(panel('chart').querySelector('svg')).toBeNull();
      expect(panel('chart').querySelector<HTMLElement>('.ui-chart-empty')!.hidden).toBe(false);
      expect(panel('chart').querySelector('tbody')!.textContent).toContain('-10');
      expect(fullSelection().blocks[0].values.every(value => value.value === false)).toBe(true);
      toggles[1].click();
      expect(panel('chart').querySelector('svg')!.outerHTML).not.toMatch(/NaN|Infinity/);
    },
  );

  it('paginates chart source values independently of the visible series', () => {
    mount([
      {
        type: 'chart',
        id: 'chart',
        title: 'Chart',
        chartType: 'line',
        labels: Array.from({ length: 8 }, (_, index) => `D${index}`),
        series: [{ id: 'one', label: 'One', values: [-5, -4, -3, -2, -1, 0, 1, 2] }],
      },
    ]);
    expect(panel('chart').querySelectorAll('tbody tr')).toHaveLength(5);
    panel('chart').querySelectorAll<HTMLButtonElement>('.ui-pager button')[1].click();
    expect(panel('chart').querySelectorAll('tbody tr')).toHaveLength(3);
    expect(panel('chart').querySelector('tbody')!.textContent).toContain('D7');
  });

  it('adapts the drawing viewport to visible width and redraws after hidden panels are shown', () => {
    let width = 700;
    let observed!: HTMLElement;
    let resized!: () => void;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const queueFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.fn((id: number) => frames.delete(id));
    const disconnect = vi.fn();
    vi.stubGlobal('requestAnimationFrame', queueFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const paint = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(0));
    };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(element: HTMLElement) {
          observed = element;
          Object.defineProperty(element, 'clientWidth', {
            configurable: true,
            get: () => (element.closest<HTMLElement>('.ui-panel')!.hidden ? 0 : width),
          });
        }
        disconnect = disconnect;
      },
    );
    mount([
      table,
      {
        type: 'chart',
        id: 'chart',
        title: 'Chart',
        chartType: 'line',
        labels: Array.from({ length: 12 }, (_, index) => `很长的中文坐标轴标签-${index}`),
        series: [{ id: 'one', label: 'One', values: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5] }],
      },
    ]);
    const switches = document.querySelectorAll<HTMLButtonElement>('.ui-nav button');
    switches[1].click();
    paint();
    expect(panel('chart').querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 700 260');
    const wideLabels = panel('chart').querySelectorAll('svg text').length;
    width = 284;
    const beforeResize = panel('chart').querySelector('svg');
    resized();
    resized();
    resized();
    expect(frames.size).toBe(1);
    expect(panel('chart').querySelector('svg')).toBe(beforeResize);
    paint();
    const narrow = panel('chart').querySelector('svg')!;
    expect(narrow.getAttribute('viewBox')).toBe('0 0 284 260');
    expect(narrow.querySelectorAll('text').length).toBeLessThan(wideLabels);
    expect(
      [...narrow.querySelectorAll('text[y="232"]')].every(
        label => (label.firstChild?.textContent?.length ?? 0) <= 5,
      ),
    ).toBe(true);
    expect(narrow.querySelector('line.ui-zero')).not.toBeNull();
    expect(narrow.outerHTML).not.toMatch(/NaN|Infinity/);
    panel('chart').querySelector<HTMLButtonElement>('.ui-legend button')!.focus();
    width = 312;
    resized();
    paint();
    expect(document.activeElement).toBe(panel('chart').querySelector('.ui-legend button'));
    switches[0].click();
    width = 500;
    resized();
    paint();
    expect(panel('chart').querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 312 260');
    switches[1].click();
    paint();
    expect(panel('chart').querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 500 260');
    expect(observed.closest('.ui-panel')).toBe(panel('chart'));
    expect(panel('chart').querySelector('tbody')!.textContent).toContain('-6');
    expect(fullSelection().blocks[1].values[0].value).toBe(true);
    const afterResize = panel('chart').querySelector('svg');
    resized();
    paint();
    expect(panel('chart').querySelector('svg')).toBe(afterResize);
    width = 600;
    resized();
    const queuedId = frameId;
    const canceledPaint = frames.get(queuedId)!;
    window.dispatchEvent(new Event('pagehide'));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalledWith(queuedId);
    expect(frames.size).toBe(0);
    resized();
    canceledPaint(0);
    expect(frames.size).toBe(0);
    expect(panel('chart').querySelector('svg')).toBe(afterResize);
  });

  it('disconnects a detached chart before a queued frame can mutate its document', () => {
    let observed!: HTMLElement;
    let resized!: () => void;
    let paint!: FrameRequestCallback;
    const disconnect = vi.fn();
    const queueFrame = vi.fn((callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', queueFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(element: HTMLElement) {
          observed = element;
        }
        disconnect = disconnect;
      },
    );
    mount([
      {
        type: 'chart',
        id: 'chart',
        title: 'Detached chart',
        chartType: 'line',
        labels: ['A', 'B'],
        series: [{ id: 'one', label: 'One', values: [0, 1] }],
      },
    ]);
    const svg = observed.querySelector('svg');
    observed.remove();
    paint(0);
    resized();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(queueFrame).toHaveBeenCalledTimes(1);
    expect(observed.querySelector('svg')).toBe(svg);
  });

  it('keeps steps collapsed and records expanded steps without altering body text', () => {
    mount([
      {
        type: 'steps',
        id: 'steps',
        title: 'Explain',
        items: [
          { title: 'First', body: '<script>unsafe()</script>' },
          { title: 'Second', body: 'Next' },
        ],
      },
    ]);
    const details = panel('steps').querySelectorAll<HTMLDetailsElement>('details');
    expect([...details].every(detail => !detail.open)).toBe(true);
    details[1].open = true;
    details[1].dispatchEvent(new Event('toggle'));
    expect(fullSelection().blocks[0].values[1].value).toBe(true);
    expect(panel('steps').querySelector('script')).toBeNull();
  });

  it('keeps only one maximum-length explanation open without changing its full text', () => {
    const body = '长'.repeat(400);
    mount(
      [
        {
          type: 'steps',
          id: 'steps',
          title: 'Maximum steps',
          items: Array.from({ length: 12 }, (_, index) => ({
            title: `${index}` + '步'.repeat(78),
            body,
          })),
        },
      ],
      'zh',
    );
    const details = [...panel('steps').querySelectorAll<HTMLDetailsElement>('details')];
    expect(new Set(details.map(detail => detail.getAttribute('name'))).size).toBe(1);
    details.forEach(detail => {
      detail.open = true;
      detail.dispatchEvent(new Event('toggle'));
      expect(details.filter(candidate => candidate.open)).toHaveLength(1);
      expect(detail.querySelector('p')!.textContent).toBe(body);
    });
    expect(fullSelection().blocks[0].values.filter(value => value.value === true)).toHaveLength(1);
  });
});

describe('forms and the bounded private prompt bridge', () => {
  it('requires the mounted policy and rejects synthetic clicks', () => {
    mount([table]);
    const follow = document.getElementById('ui-follow') as HTMLButtonElement;
    expect(follow.disabled).toBe(true);
    policy(true, {} as MessageEventSource);
    expect(follow.disabled).toBe(true);
    policy();
    expect(follow.disabled).toBe(false);
    follow.click();
    expect(send).not.toHaveBeenCalled();
    clickTrustedHandler();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain(uiLabels.en.valuesHeading);
  });

  it('locates invalid controls in hidden panels and validates required/number/select/checkbox', async () => {
    mount([table, form]);
    policy();
    clickTrustedHandler();
    expect(panel('form').hidden).toBe(false);
    expect(document.activeElement).toBe(field('goal'));
    expect(field('goal').getAttribute('aria-invalid')).toBe('true');
    expect(send).not.toHaveBeenCalled();
    edit(field('goal'), 'Goal');
    edit(field('budget'), '200');
    clickTrustedHandler();
    expect(document.activeElement).toBe(field('budget'));
    expect(panel('form').textContent).toContain(uiLabels.en.rangeError);
    edit(field('budget'), '-2.5');
    edit(field('choice'), 'not-an-option');
    clickTrustedHandler();
    expect(document.activeElement).toBe(field('choice'));
    edit(field('choice'), 'B');
    clickTrustedHandler();
    expect(document.activeElement).toBe(field('agree'));
    (field('agree') as HTMLInputElement).checked = true;
    field('agree').dispatchEvent(new Event('change', { bubbles: true }));
    clickTrustedHandler();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('"value":-2.5');
    expect(
      fullSelection().blocks[1].values.find(value => value.id === 'optional')!.value,
    ).toBeNull();
    await Promise.resolve();
  });

  it('enforces text length and does not lose focus when values are refreshed', () => {
    mount([
      { ...form, fields: [{ id: 'goal', label: 'Goal', type: 'text', value: '', maxLength: 4 }] },
    ]);
    field('goal').focus();
    edit(field('goal'), '12345');
    expect(document.activeElement).toBe(field('goal'));
    expect(field('goal').getAttribute('aria-invalid')).toBe('true');
    policy();
    clickTrustedHandler();
    expect(send).not.toHaveBeenCalled();
    edit(field('goal'), '1234');
    clickTrustedHandler();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps every DOM identity and accessible reference unique for ambiguous hyphenated IDs', () => {
    mount([
      {
        type: 'form',
        id: 'foo',
        title: 'First',
        fields: [
          { id: 'field-bar', label: 'First field', type: 'text', value: '' },
          { id: 'field-bar-error', label: 'Error suffix field', type: 'text', value: '' },
        ],
      },
      {
        type: 'form',
        id: 'foo-field',
        title: 'Second',
        fields: [{ id: 'bar', label: 'Second field', type: 'text', value: '' }],
      },
      {
        type: 'chart',
        id: 'foo-field-bar-error',
        title: 'Chart',
        chartType: 'bar',
        labels: ['A', 'B'],
        series: [{ id: 'one', label: 'One', values: [-1, 0] }],
      },
      {
        type: 'table',
        id: 'foo-panel',
        title: 'Table',
        columns: [{ id: 'field', label: 'Text', type: 'text' }],
        rows: [['A']],
      },
    ]);
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    document.querySelectorAll<HTMLLabelElement>('label[for]').forEach(label => {
      expect(label.control).not.toBeNull();
      expect(label.control!.closest('.ui-panel')).toBe(label.closest('.ui-panel'));
    });
    document
      .querySelectorAll('[aria-describedby],[aria-labelledby],[aria-controls]')
      .forEach(node => {
        ['aria-describedby', 'aria-labelledby', 'aria-controls'].forEach(attribute => {
          const reference = node.getAttribute(attribute);
          if (reference)
            reference.split(' ').forEach(id => expect(document.getElementById(id)).not.toBeNull());
        });
      });
    expect(document.getElementById('ui_foo_field_field-bar')).not.toBe(
      document.getElementById('ui_foo-field_field_bar'),
    );
  });

  it('keeps all blocks in a fair escaped summary and complete values locally', () => {
    const text = '\\"\n😀'.repeat(25);
    const blocks = Array.from({ length: 8 }, (_, index) => ({
      type: 'form',
      id: `form-${index}`,
      title: `Form ${index}`,
      fields: Array.from({ length: 12 }, (_, fieldIndex) => ({
        id: `field-${fieldIndex}`,
        label: '\\"'.repeat(35),
        type: 'text',
        value: text,
      })),
    }));
    mount(blocks, 'zh', 'Title '.repeat(50));
    policy();
    clickTrustedHandler();
    const sent = send.mock.calls[0][0] as string;
    expect(sent.length).toBeLessThanOrEqual(3600);
    const payload = JSON.parse(sent.slice(sent.indexOf('{')));
    expect(payload.blocks).toHaveLength(8);
    expect(
      payload.blocks.every(
        (block: { values: unknown[]; omitted: number; truncated: number }) =>
          block.values.length > 0 && (block.omitted > 0 || block.truncated > 0),
      ),
    ).toBe(true);
    expect(payload.blocks.map((block: { id: string }) => block.id)).toEqual(
      blocks.map(block => block.id),
    );
    expect(fullSelection().blocks[7].values).toHaveLength(12);
    expect(fullSelection().blocks[7].values[0].value).toBe(text);
    expect((document.getElementById('ui-full-values') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(document.querySelector('.ui-footer')!.textContent).toContain(uiLabels.zh.truncated);
  });

  it('disables follow-up when the bridge rejects or is revoked', async () => {
    send.mockImplementation(() => false);
    mount([table]);
    policy();
    clickTrustedHandler();
    await Promise.resolve();
    await Promise.resolve();
    expect((document.getElementById('ui-follow') as HTMLButtonElement).disabled).toBe(true);
    send.mockImplementation(() => true);
    policy();
    policy(false);
    clickTrustedHandler();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds encoded titles for every legal block instead of dropping follow-up silently', () => {
    const title = '\u0001'.repeat(80);
    const blocks = Array.from({ length: 8 }, (_, index) => ({
      type: 'form',
      id: `form-${index}`,
      title,
      fields: [
        { id: 'field', label: '\u0001'.repeat(80), type: 'text', value: '\u0001'.repeat(400) },
      ],
    }));
    mount(blocks, 'en', '\u0001'.repeat(400));
    policy();
    clickTrustedHandler();
    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0][0] as string;
    expect(text.length).toBeLessThanOrEqual(3600);
    const payload = JSON.parse(text.slice(text.indexOf('{')));
    expect(payload.titleTruncated).toBe(true);
    expect(JSON.stringify(payload.title).length).toBeLessThanOrEqual(300);
    expect(payload.blocks).toHaveLength(8);
    expect(
      payload.blocks.every(
        (block: { title: string; titleTruncated: boolean }) =>
          block.titleTruncated && JSON.stringify(block.title).length <= 128,
      ),
    ).toBe(true);
    expect(fullSelection().blocks[7].values[0].value).toBe('\u0001'.repeat(400));
  });

  it('serializes executable helpers without external closures and has complete language labels', () => {
    const doc = parseUiDocument(
      JSON.stringify({ version: 1, language: 'en', summary: 'Standalone', blocks: [table] }),
    );
    new Function('boot', `(${uiRuntime.toString()})(boot);`)({
      document: doc,
      labels: uiLabels.en,
    });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(Object.keys(uiLabels.en).sort()).toEqual(Object.keys(uiLabels.zh).sort());
  });
});
