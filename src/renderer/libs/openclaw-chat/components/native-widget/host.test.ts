// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeWidgetSandboxHost, resolveNativeSandboxUrl, WIDGET_TIMEOUT_MS } from './host';
import { WIDGET_LAYOUT_REQUEST, WIDGET_MEASURED_HEIGHT } from './sizing';

const gateway = 'ws://127.0.0.1:18789';
const hostOrigin = 'http://127.0.0.1:43180';
const view = { sandboxPort: 18790, sandboxUrl: '/mcp-app-sandbox' };

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native sandbox transport', () => {
  it('accepts the actual locked Gateway canvas.document.view sandbox metadata', () => {
    const actual = {
      sandboxPort: 5103,
      sandboxUrl:
        '/mcp-app-sandbox?csp=eyJyZXNvdXJjZURvbWFpbnMiOlsiaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbSIsImh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldCIsImh0dHBzOi8vZXNtLnNoIiwiaHR0cHM6Ly91bnBrZy5jb20iLCJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tIiwiaHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbSIsImh0dHBzOi8vZm9udHMuYnVubnkubmV0Il0sIm1lZGlhRG9tYWlucyI6WyJodHRwczoiLCJibG9iOiJdLCJibG9ja0Rlc2NlbmRhbnRGcmFtZXMiOnRydWV9&v=1cdfe67bd67e7990c9eaafa189866ee4fa449f9692071868d746cf1747f7fb7c',
    };
    expect(resolveNativeSandboxUrl(actual, 'ws://127.0.0.1:5102', 'http://127.0.0.1:43183')).toBe(
      `http://127.0.0.1:5103${actual.sandboxUrl}`,
    );
  });

  it('accepts only the dedicated configured Gateway listener and rejects credentials, tokens and same-origin frames', () => {
    expect(resolveNativeSandboxUrl(view, gateway, hostOrigin)).toBe(
      'http://127.0.0.1:18790/mcp-app-sandbox',
    );
    const canonical = `/mcp-app-sandbox?csp=${btoa(JSON.stringify({ blockDescendantFrames: true })).replace(/=+$/, '')}&v=${'a'.repeat(64)}`;
    expect(resolveNativeSandboxUrl({ ...view, sandboxUrl: canonical }, gateway, hostOrigin)).toBe(
      'http://127.0.0.1:18790' + canonical,
    );
    for (const candidate of [
      { ...view, sandboxPort: 18789 },
      { ...view, sandboxOrigin: 'https://evil.test' },
      { ...view, sandboxUrl: 'http://user:password@127.0.0.1:18790/mcp-app-sandbox' },
      { ...view, sandboxUrl: '/mcp-app-sandbox?token=secret' },
      { ...view, sandboxUrl: '/arbitrary' },
      { ...view, sandboxUrl: `/mcp-app-sandbox?v=${'a'.repeat(64)}&v=${'b'.repeat(64)}` },
      { ...view, sandboxUrl: `/mcp-app-sandbox?csp=${'a'.repeat(7000)}&v=${'a'.repeat(64)}` },
    ])
      expect(() => resolveNativeSandboxUrl(candidate, gateway, hostOrigin)).toThrow();
    expect(() => resolveNativeSandboxUrl(view, gateway, 'file:///app/index.html')).toThrow();
  });

  it('delivers bytes only after the exact proxy ready message and accepts only the current render acknowledgement', () => {
    vi.useFakeTimers();
    const frame = document.createElement('iframe');
    frame.src = 'http://127.0.0.1:18790/mcp-app-sandbox';
    const widget = document.createElement('justdo-native-widget');
    widget.attachShadow({ mode: 'open' }).append(frame);
    document.body.append(widget);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const loaded = vi.fn();
    const failed = vi.fn();
    const url = 'http://127.0.0.1:18790/mcp-app-sandbox';
    const transport = new NativeWidgetSandboxHost(frame, url, '<p>widget</p>', loaded, failed);
    const message = (source: Window | null, origin: string, data: unknown) =>
      new MessageEvent('message', { source, origin, data });
    const ready = { method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: url } };
    transport.handleMessage(message(window, new URL(url).origin, ready));
    transport.handleMessage(message(frame.contentWindow, 'https://evil.test', ready));
    expect(post).not.toHaveBeenCalled();
    transport.handleMessage(message(frame.contentWindow, new URL(url).origin, ready));
    const params = post.mock.calls[0][0].params;
    expect(params.html).toContain('<p>widget</p>');
    expect(params.html).toContain('widget-view:measured-height');
    transport.handleMessage(
      message(frame.contentWindow, new URL(url).origin, {
        method: 'ui/notifications/sandbox-resource-loaded',
        params: { renderId: 'stale' },
      }),
    );
    expect(loaded).not.toHaveBeenCalled();
    transport.handleMessage(
      message(frame.contentWindow, new URL(url).origin, {
        method: 'ui/notifications/sandbox-resource-loaded',
        params: { renderId: params.renderId },
      }),
    );
    expect(loaded).toHaveBeenCalledOnce();
    transport.dispose();
    vi.advanceTimersByTime(WIDGET_TIMEOUT_MS + 1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('reports a timeout once and never silently reloads a failed frame', () => {
    vi.useFakeTimers();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const failed = vi.fn();
    const transport = new NativeWidgetSandboxHost(
      frame,
      'http://127.0.0.1:18790/mcp-app-sandbox',
      '<p/>',
      vi.fn(),
      failed,
    );
    vi.advanceTimersByTime(10_000);
    expect(failed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WIDGET_TIMEOUT_MS - 10_000);
    expect(failed).toHaveBeenCalledOnce();
    expect(frame.getAttribute('src')).toBeNull();
    transport.dispose();
  });

  it('admits only the current sizing identity, revision and source viewport', () => {
    const widget = document.createElement('justdo-native-widget');
    const frame = document.createElement('iframe');
    frame.src = 'http://127.0.0.1:18790/mcp-app-sandbox';
    widget.attachShadow({ mode: 'open' }).append(frame);
    document.body.append(widget);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const host = new NativeWidgetSandboxHost(
      frame,
      frame.src,
      '<body>fixture</body>',
      vi.fn(),
      vi.fn(),
    );
    const receive = (
      data: unknown,
      source = frame.contentWindow,
      origin = new URL(frame.src).origin,
    ) => host.handleMessage(new MessageEvent('message', { data, source, origin }));
    receive({ method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: frame.src } });
    const first = { revision: 1, expanded: true, width: 840, height: 877 };
    host.setLayout(first);
    const { id } = post.mock.calls.find(([data]) => data?.type === WIDGET_LAYOUT_REQUEST)![0];
    const measured = {
      type: WIDGET_MEASURED_HEIGHT,
      id,
      revision: 1,
      width: 840,
      viewportHeight: 877,
      height: 877,
    };
    expect(receive(measured)).toEqual({ height: 877, revision: 1 });
    host.setLayout({ ...first, revision: 2, expanded: false, height: 420 });
    host.setLayout(first);
    expect(receive(measured)).toBeUndefined();
    const current = { ...measured, revision: 2, viewportHeight: 420, height: 640 };
    expect(receive(current)).toEqual({ height: 640, revision: 2 });
    expect(receive(current, window)).toBeUndefined();
    expect(receive(current, frame.contentWindow, 'https://evil.test')).toBeUndefined();
    for (const patch of [
      { id: 'old' },
      { width: 700 },
      { viewportHeight: 877 },
      { height: Infinity },
      { height: '640' },
    ])
      expect(receive({ ...current, ...patch })).toBeUndefined();
    expect(receive({ type: 'openclaw:widget-size', height: 877 })).toBeUndefined();
    host.dispose();
    expect(receive(current)).toBeUndefined();
  });
});
