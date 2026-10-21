import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { WIDGET_LAYOUT_REQUEST, WIDGET_MEASURED_HEIGHT, withWidgetSizing } from './sizing';

describe('document-owned widget sizing', () => {
  it('preserves the native doctype, CSP, markup and scripts around the added reporter', () => {
    const head =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'"></head><body class="svg-widget">';
    const body = '<canvas></canvas><script>window.identity=1</script></body></html>';
    const result = withWidgetSizing(head + body, 'fixture');
    expect(result.startsWith(head + '<script>')).toBe(true);
    expect(result.endsWith(body)).toBe(true);
    expect(
      withWidgetSizing('<!doctype html><p>fragment</p>', 'fixture').startsWith('<!doctype html>'),
    ).toBe(true);
  });

  it('measures only after the actual document viewport matches the requested revision', () => {
    const listeners = new Map<string, (event?: unknown) => void>();
    const frames: Array<() => void> = [];
    const postMessage = vi.fn();
    const parent = { postMessage };
    const body = {
      scrollHeight: 420,
      offsetHeight: 420,
      getBoundingClientRect: () => ({ height: body.offsetHeight }),
    };
    const context = {
      window: { parent },
      document: { body, documentElement: {}, readyState: 'complete' },
      innerWidth: 840,
      innerHeight: 420,
      ResizeObserver: class {
        constructor(callback: () => void) {
          listeners.set('observe', callback);
        }
        observe() {}
      },
      addEventListener: (type: string, callback: (event?: unknown) => void) =>
        listeners.set(type, callback),
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
    };
    const source = withWidgetSizing('<body></body>', 'fixture').match(
      /<script>([\s\S]*?)<\/script>/u,
    )![1];
    runInNewContext(source, context);
    const flush = () => frames.splice(0).forEach(callback => callback());
    const request = (revision: number, height: number, source: unknown = parent) =>
      listeners.get('message')!({
        source,
        data: {
          type: WIDGET_LAYOUT_REQUEST,
          id: 'fixture',
          layout: { revision, expanded: revision === 2, width: 840, height },
        },
      });
    const reports = () =>
      postMessage.mock.calls
        .filter(([data]) => data.type === WIDGET_MEASURED_HEIGHT)
        .map(([data]) => data);
    flush();
    expect(reports()).toHaveLength(0);
    request(1, 420);
    flush();
    expect(reports().slice(-1)[0]).toMatchObject({ revision: 1, height: 420, viewportHeight: 420 });
    request(2, 877);
    flush();
    expect(reports()).toHaveLength(1);
    context.innerHeight = body.scrollHeight = body.offsetHeight = 877;
    listeners.get('resize')!();
    flush();
    expect(reports().slice(-1)[0]).toMatchObject({ revision: 2, height: 877, viewportHeight: 877 });
    request(3, 420);
    flush();
    expect(reports()).toHaveLength(2);
    context.innerHeight = body.scrollHeight = body.offsetHeight = 420;
    listeners.get('resize')!();
    flush();
    expect(reports().slice(-1)[0]).toMatchObject({ revision: 3, height: 420, viewportHeight: 420 });
    request(2, 877);
    request(99, 877, {});
    body.scrollHeight = body.offsetHeight = 640;
    listeners.get('observe')!();
    flush();
    expect(reports().slice(-1)[0]).toMatchObject({ revision: 3, height: 640, viewportHeight: 420 });
  });
});
