import { createContext, runInContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import {
  normalizeWidgetLink,
  WIDGET_LINK_OFFER,
  WIDGET_LINK_OPEN,
  WIDGET_LINK_READY,
  withWidgetLinks,
} from './links';
import { withWidgetSizing } from './sizing';

type ClickOptions = {
  type?: string;
  button?: number;
  isTrusted?: boolean;
  defaultPrevented?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

function linkFixture() {
  const postMessage = vi.fn();
  const send = vi.fn();
  const prevented = vi.fn();
  const context = createContext({ postMessage, send, prevented });
  runInContext(
    `
      let userActive = true;
      const timers = new Map();
      let nextTimer = 0;
      let setTimeout = callback => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      };
      let clearTimeout = id => timers.delete(id);
      class EventTarget {
        constructor() { this.listeners = new Map(); }
        addEventListener(type, callback, options) {
          const entries = this.listeners.get(type) ?? [];
          entries.push({ callback, once: options?.once, removed: false });
          this.listeners.set(type, entries);
        }
        removeEventListener(type, callback) {
          const entries = this.listeners.get(type) ?? [];
          for (let index = 0; index < entries.length; index++) {
            if (entries[index].callback === callback) entries[index].removed = true;
          }
        }
        listenerCount(type) {
          return (this.listeners.get(type) ?? []).filter(entry => !entry.removed).length;
        }
      }
      class Element {
        constructor(name, attributes) {
          this.name = name;
          this.attributes = attributes;
        }
        get localName() {
          if (!(this instanceof Element)) throw new TypeError('not an element');
          return this.name;
        }
        getAttribute(name) {
          if (!(this instanceof Element)) throw new TypeError('not an element');
          return this.attributes[name] ?? null;
        }
      }
      class Event {
        constructor(nodes, options) {
          this.nodes = nodes;
          this.type = 'click';
          this.button = 0;
          this.isTrusted = true;
          this.canceled = options.defaultPrevented ?? false;
          this.propagationStopped = false;
          this.immediatePropagationStopped = false;
          this.shiftKey = false;
          this.altKey = false;
          const keys = Object.keys(options);
          for (let index = 0; index < keys.length; index++) {
            if (keys[index] !== 'defaultPrevented') this[keys[index]] = options[keys[index]];
          }
        }
        get defaultPrevented() { return this.canceled; }
        composedPath() {
          const result = [];
          for (let index = 0; index < this.nodes.length; index++) result.push(this.nodes[index]);
          return result;
        }
        preventDefault() {
          this.canceled = true;
          prevented();
        }
        stopPropagation() { this.propagationStopped = true; }
        stopImmediatePropagation() {
          this.stopPropagation();
          this.immediatePropagationStopped = true;
        }
      }
      class UserActivation {
        get isActive() { return userActive; }
      }
      const navigator = { userActivation: new UserActivation() };
      const port = { postMessage: send, start() {}, onmessage: undefined };
      class MessageChannel {
        constructor() { this.port1 = port; this.port2 = {}; }
      }
      const window = new EventTarget();
      window.parent = { postMessage };
      window.setTimeout = setTimeout;
      window.clearTimeout = clearTimeout;
      const document = new EventTarget();
      const dispatch = (target, event) => {
        const entries = (target.listeners.get(event.type) ?? []).slice();
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (entry.removed) continue;
          if (entry.once) entry.removed = true;
          entry.callback(event);
          if (event.immediatePropagationStopped) break;
        }
      };
      const anchor = (attributes = {}, name = 'a') => new Element(name, attributes);
      const activate = (nodes, options = {}) => {
        const event = new Event(nodes, options);
        dispatch(document, event);
        if (!event.propagationStopped) dispatch(window, event);
        return event;
      };
      const flushTimers = () => {
        const ids = Array.from(timers.keys());
        for (let index = 0; index < ids.length; index++) {
          const callback = timers.get(ids[index]);
          timers.delete(ids[index]);
          callback?.();
        }
      };
    `,
    context,
  );
  const script = withWidgetLinks('<!doctype html><body></body>', 'fixture-link-id').match(
    /<script>([\s\S]*?)<\/script>/u,
  )![1];
  runInContext(script, context);
  const activate = runInContext('activate', context) as (
    path: unknown[],
    options?: ClickOptions,
  ) => { defaultPrevented: boolean };
  const anchor = runInContext('anchor', context) as (
    attributes?: Record<string, string | undefined>,
    name?: string,
  ) => unknown;
  return {
    anchor,
    activate,
    postMessage,
    send,
    prevented,
    flushTimers: () => runInContext('flushTimers()', context),
    pendingTimers: () => runInContext('timers.size', context) as number,
    pendingWindowListeners: () => runInContext('window.listenerCount("click")', context) as number,
    run: (source: string) => runInContext(source, context),
    ready: (type = WIDGET_LINK_READY) => {
      context.readyType = type;
      runInContext('port.onmessage({ data: { type: readyType } })', context);
    },
  };
}

describe('widget web-link admission', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['HTTP://Example.COM:80/report?q=1#chart', 'http://example.com/report?q=1#chart'],
    ['https://example.com/my%20report', 'https://example.com/my%20report'],
    ['http://127.0.0.1:43127/report', 'http://127.0.0.1:43127/report'],
  ])('normalizes the admitted web address %s', (raw, expected) => {
    expect(normalizeWidgetLink(raw)).toBe(expected);
  });

  it.each([
    undefined,
    {},
    '',
    '#chart',
    '/report',
    '//example.com/report',
    'file:///C:/report.html',
    'javascript:alert(1)',
    'data:text/html,hello',
    'mailto:person@example.com',
    'https://user:password@example.com/report',
    'https://user@example.com/report',
    'https://example.com/a b',
    ' https://example.com',
    'https://example.com\n',
    'https://example.com/\u0000',
    'https://example.com/\u007f',
    `https://example.com/${'x'.repeat(8192)}`,
  ])('rejects non-web, credentialed or malformed address %s', raw => {
    expect(normalizeWidgetLink(raw)).toBeUndefined();
  });
});

describe('document-owned widget link bridge', () => {
  it('inserts ahead of existing scripts while preserving the native doctype, CSP and markup', () => {
    const prefix = '\uFEFF  <!--native document-->\n<!DoCtYpE html>';
    const document =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'"><script>window.existingHeadScript=true</script></head><body><script>window.existingBodyScript=true</script><a href="https://example.com">Report</a></body></html>';
    const adapted = withWidgetSizing(prefix + document, 'fixture-sizing');
    const result = withWidgetLinks(adapted, 'fixture-link-id');

    expect(result.startsWith(prefix + '<script>')).toBe(true);
    expect(result.endsWith(adapted.slice(prefix.length))).toBe(true);
    expect(result.indexOf(WIDGET_LINK_OFFER)).toBeLessThan(result.indexOf('existingHeadScript'));
    expect(withWidgetLinks('<a href="https://example.com">Report</a>', 'id')).toMatch(
      /^<script>[\s\S]*<\/script><a /u,
    );
  });

  it('safely serializes the private mount identifier', () => {
    const output = withWidgetLinks(
      '<!doctype html><body></body>',
      '</script><script>bad()</script>',
    );
    expect(output.match(/<script>/gu)).toHaveLength(1);
    expect(output.match(/<\/script>/gu)).toHaveLength(1);
    expect(output).not.toContain('bad()</script>');
  });

  it('offers a private link port before clicks and waits for its exact host readiness message', () => {
    const fixture = linkFixture();
    const anchor = fixture.anchor({ href: 'https://example.com/report' });

    expect(fixture.postMessage).toHaveBeenCalledOnce();
    expect(fixture.postMessage.mock.calls[0]).toMatchObject([
      { type: WIDGET_LINK_OFFER, linkId: 'fixture-link-id' },
      '*',
      [expect.any(Object)],
    ]);
    expect(fixture.activate([anchor]).defaultPrevented).toBe(false);
    fixture.ready('openclaw:widget-host-init');
    expect(fixture.activate([anchor]).defaultPrevented).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();

    fixture.ready();
    expect(fixture.activate([anchor]).defaultPrevented).toBe(true);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: WIDGET_LINK_OPEN,
      url: 'https://example.com/report',
    });
  });

  it.each([{}, { ctrlKey: true }, { metaKey: true }, { type: 'auxclick', button: 1 }])(
    'opens an actual HTTP anchor for the supported activation %j',
    options => {
      const fixture = linkFixture();
      fixture.ready();
      const anchor = fixture.anchor({ href: '  HTTPS://example.com/report  ', target: '_blank' });

      const event = fixture.activate([{}, fixture.anchor({}, 'span'), anchor, {}], options);

      expect(event.defaultPrevented).toBe(true);
      expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
        type: WIDGET_LINK_OPEN,
        url: 'HTTPS://example.com/report',
      });
    },
  );

  it.each([
    { isTrusted: false },
    { defaultPrevented: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { type: 'auxclick', button: 0 },
    { type: 'auxclick', button: 2 },
  ])('leaves an anchor activation local when it is ineligible %j', options => {
    const fixture = linkFixture();
    fixture.ready();

    fixture.activate([fixture.anchor({ href: 'https://example.com/report' })], options);

    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.prevented).not.toHaveBeenCalled();
  });

  it('requires the captured real user-activation getter', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run('userActive = false');

    fixture.activate([fixture.anchor({ href: 'https://example.com/report' })]);

    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.prevented).not.toHaveBeenCalled();
  });

  it('lets a widget window delegate cancel navigation after the injected bridge is installed', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run(`
      window.addEventListener('click', event => event.preventDefault());
    `);

    const event = fixture.activate([fixture.anchor({ href: 'https://example.com/report' })]);

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.prevented).toHaveBeenCalledOnce();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.pendingTimers()).toBe(0);
    expect(fixture.pendingWindowListeners()).toBe(1);
  });

  it('uses the captured cancellation getter when a widget masks defaultPrevented', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run(`
      window.addEventListener('click', event => event.preventDefault());
      Object.defineProperty(Event.prototype, 'defaultPrevented', { get() { return false; } });
    `);

    fixture.activate([fixture.anchor({ href: 'https://example.com/report' })]);

    expect(fixture.prevented).toHaveBeenCalledOnce();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('cleans up its pending final listener when a document delegate stops propagation', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run(`
      const stopAtDocument = event => event.stopPropagation();
      document.addEventListener('click', stopAtDocument);
    `);

    fixture.activate([fixture.anchor({ href: 'https://example.com/report' })]);

    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.pendingWindowListeners()).toBe(1);
    expect(fixture.pendingTimers()).toBe(1);
    fixture.flushTimers();
    expect(fixture.pendingWindowListeners()).toBe(0);
    expect(fixture.pendingTimers()).toBe(0);

    fixture.run(`document.removeEventListener('click', stopAtDocument)`);
    fixture.activate([fixture.anchor({ href: 'https://example.com/next' })]);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: WIDGET_LINK_OPEN,
      url: 'https://example.com/next',
    });
    expect(fixture.pendingWindowListeners()).toBe(0);
    expect(fixture.pendingTimers()).toBe(0);
  });

  it('cannot reuse a propagation-blocked click when a different click reaches the window', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run(`
      let stopNextClick = true;
      document.addEventListener('click', event => {
        if (!stopNextClick) return;
        stopNextClick = false;
        event.stopPropagation();
      });
    `);

    fixture.activate([fixture.anchor({ href: 'https://example.com/blocked' })]);
    fixture.activate([fixture.anchor({ href: 'https://example.com/allowed' })]);

    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: WIDGET_LINK_OPEN,
      url: 'https://example.com/allowed',
    });
    fixture.flushTimers();
    expect(fixture.pendingWindowListeners()).toBe(0);
    expect(fixture.pendingTimers()).toBe(0);
  });

  it.each([
    { href: '#chart' },
    { href: 'relative/report.html' },
    { href: 'file:///C:/report.html' },
    { href: 'javascript:void(0)' },
    { href: 'mailto:person@example.com' },
    { href: 'https://example.com/report', download: '' },
    {},
  ])('preserves fragment, local or download handling for %j', attributes => {
    const fixture = linkFixture();
    fixture.ready();

    const event = fixture.activate([fixture.anchor(attributes)]);

    expect(event.defaultPrevented).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('accepts an SVG anchor with xlink:href through native element accessors', () => {
    const fixture = linkFixture();
    fixture.ready();

    fixture.activate([
      fixture.anchor({}, 'path'),
      fixture.anchor({ 'xlink:href': 'https://example.com/svg-report' }),
    ]);

    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: WIDGET_LINK_OPEN,
      url: 'https://example.com/svg-report',
    });
  });

  it('keeps its captured event, DOM, activation and private send primitives after widget overrides', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run(`
      Event.prototype.composedPath = () => [];
      Event.prototype.preventDefault = () => { throw new Error('replaced preventDefault'); };
      Element.prototype.getAttribute = () => null;
      Object.defineProperty(Element.prototype, 'localName', { get() { return 'button'; } });
      Object.defineProperty(UserActivation.prototype, 'isActive', { get() { return false; } });
      Object.defineProperty(Event.prototype, 'defaultPrevented', { get() { return true; } });
      Reflect.apply = () => { throw new Error('replaced apply'); };
      String.prototype.trim = () => 'javascript:alert(1)';
      RegExp.prototype.test = () => false;
      port.postMessage = () => { throw new Error('replaced send'); };
      document.addEventListener = () => { throw new Error('replaced document listen'); };
      window.addEventListener = () => { throw new Error('replaced window listen'); };
      window.removeEventListener = () => { throw new Error('replaced window remove'); };
      setTimeout = window.setTimeout = () => { throw new Error('replaced timer'); };
      clearTimeout = window.clearTimeout = () => { throw new Error('replaced timer cancel'); };
    `);

    fixture.activate([fixture.anchor({ href: ' https://example.com/report ' })]);

    expect(fixture.prevented).toHaveBeenCalledOnce();
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: WIDGET_LINK_OPEN,
      url: 'https://example.com/report',
    });
    expect(fixture.pendingWindowListeners()).toBe(0);
    expect(fixture.pendingTimers()).toBe(0);
  });

  it('cannot turn a trusted button click into an anchor click by replacing array iteration', () => {
    const fixture = linkFixture();
    fixture.ready();
    fixture.run(`
      const unrelatedAnchor = anchor({ href: 'https://example.com/unrelated' });
      Array.prototype[Symbol.iterator] = function* () { yield unrelatedAnchor; };
    `);

    const event = fixture.activate([fixture.anchor({}, 'button')]);

    expect(event.defaultPrevented).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
