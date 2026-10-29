/** @vitest-environment jsdom */

import { html, render } from 'lit';
import { afterEach, expect, test, vi } from 'vitest';

import { historyViewport, type HistoryViewportHandle } from './history-viewport';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getSelection()?.removeAllRanges();
});

function setup(count = 1_000, options: { disclosures?: boolean; outerAcrossShadow?: boolean } = {}) {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  );
  const host = document.createElement('div');
  const list = document.createElement('div');
  const details = document.createElement('details');
  const outerDetails = document.createElement('details');
  details.open = true;
  outerDetails.open = true;
  if (options.disclosures) {
    details.append(document.createElement('summary'), list);
    outerDetails.append(document.createElement('summary'));
    if (options.outerAcrossShadow) {
      host.attachShadow({ mode: 'open' }).append(details);
      outerDetails.append(host);
      document.body.append(outerDetails);
    } else {
      outerDetails.append(details);
      host.append(outerDetails);
      document.body.append(host);
    }
  } else {
    host.append(list);
    document.body.append(host);
  }
  Object.defineProperties(host, {
    clientHeight: { value: 400 },
    scrollHeight: {
      get: () => [...list.children].reduce((height, element) => height + elementHeight(element), 0),
    },
  });
  function elementHeight(element: Element) {
    return element.classList.contains('history-viewport-row')
      ? 100
      : Number.parseFloat((element as HTMLElement).style.height) || 0;
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (options.disclosures && !outerDetails.open) return new DOMRect();
    if (this === host) return new DOMRect(0, 0, 500, 400);
    if (options.disclosures && !details.open) return new DOMRect();
    let top = -host.scrollTop;
    if (this.parentElement === list) {
      for (const sibling of list.children) {
        if (sibling === this) break;
        top += elementHeight(sibling);
      }
    }
    return new DOMRect(0, top, 500, this === list ? host.scrollHeight : elementHeight(this));
  });
  let handle: HistoryViewportHandle | null = null;
  let follow = true;
  let deferred = false;
  let items = Array.from({ length: count }, (_, index) => `row-${index}`);
  const before = vi.fn();
  const after = vi.fn();
  const renderItem = vi.fn((item: string) => html`<button>${item}</button>`);
  const ref = (value: HistoryViewportHandle | null) => {
    handle = value;
  };
  const commit = (scope = 'native-session') =>
    render(
      historyViewport({
        items,
        key: item => item,
        render: renderItem,
        host,
        scope,
        follow: () => follow,
        defer: () => deferred,
        beforeCommit: before,
        afterCommit: after,
        ref,
      }),
      list,
    );
  const part = commit();
  const frame = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  };
  const flush = () => {
    for (let turn = 0; frames.size && turn < 10; turn += 1) frame();
    expect(frames.size).toBe(0);
  };
  const rows = () => [...list.querySelectorAll<HTMLElement>('.history-viewport-row')];
  const visibleRow = () =>
    rows().find(row => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < host.clientHeight;
    });
  return {
    host,
    list,
    details,
    outerDetails,
    frames,
    rows,
    visibleRow,
    before,
    after,
    renderItem,
    part,
    commit,
    flush,
    get handle() {
      return handle!;
    },
    setFollow: (value: boolean) => {
      follow = value;
    },
    setDeferred: (value: boolean) => {
      deferred = value;
    },
    prepend: (prefix: string[]) => {
      items = [...prefix, ...items];
    },
  };
}

test('keeps a large history bounded and replaces offscreen rows with layout spacers', () => {
  const fixture = setup(100_000);
  fixture.flush();
  expect(fixture.rows().length).toBeLessThanOrEqual(250);
  expect(fixture.rows()[fixture.rows().length - 1]?.dataset.historyKey).toBe('row-99999');
  expect(
    fixture.list.querySelector<HTMLElement>('[data-viewport-edge="before"]')!.style.height,
  ).not.toBe('0px');
  fixture.setFollow(false);
  fixture.host.scrollTop = 0;
  fixture.host.dispatchEvent(new Event('scroll'));
  fixture.flush();
  expect(fixture.rows()[0].dataset.historyKey).toBe('row-0');
  expect(
    fixture.list.querySelector<HTMLElement>('[data-viewport-edge="after"]')!.style.height,
  ).not.toBe('0px');
  expect(fixture.before).toHaveBeenCalled();
  expect(fixture.after).toHaveBeenCalledTimes(fixture.before.mock.calls.length);
});

test('retains the actual reading node when older rows are prepended', () => {
  const fixture = setup();
  fixture.host.scrollTop = fixture.host.scrollHeight - fixture.host.clientHeight;
  fixture.flush();
  fixture.setFollow(false);
  fixture.host.scrollTop = fixture.host.scrollHeight - fixture.host.clientHeight - 100;
  fixture.host.dispatchEvent(new Event('scroll'));
  fixture.flush();
  const reading = fixture.visibleRow()!;
  expect(reading).toBeDefined();
  fixture.prepend(Array.from({ length: 250 }, (_, index) => `older-${index}`));
  fixture.commit();
  expect(fixture.rows()).toContain(reading);
  expect(reading.isConnected).toBe(true);
});

test('materializes explicit targets and relinquishes that pin to real scrolling input', () => {
  const fixture = setup();
  fixture.host.scrollTop = fixture.host.scrollHeight - fixture.host.clientHeight;
  fixture.flush();
  fixture.setFollow(false);
  expect(fixture.handle.reveal('row-0')).toBe(true);
  expect(fixture.rows().some(row => row.dataset.historyKey === 'row-0')).toBe(true);
  expect(fixture.handle.offsetFor('row-0')).toBe(0);
  expect(fixture.handle.reveal('missing')).toBe(false);
  fixture.flush();
  expect(fixture.rows().some(row => row.dataset.historyKey === 'row-0')).toBe(true);
  fixture.host.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
  fixture.flush();
  expect(fixture.rows().some(row => row.dataset.historyKey === 'row-0')).toBe(false);
});

test('does not recycle rows while native scrollbar reflow is deferred', () => {
  const fixture = setup();
  fixture.flush();
  const last = fixture.rows()[fixture.rows().length - 1]!;
  fixture.setFollow(false);
  fixture.setDeferred(true);
  fixture.host.scrollTop = 0;
  fixture.host.dispatchEvent(new Event('scroll'));
  fixture.flush();
  expect(last.isConnected).toBe(true);
  fixture.setDeferred(false);
  fixture.handle.refresh();
  fixture.flush();
  expect(last.isConnected).toBe(false);
  expect(fixture.rows()[0].dataset.historyKey).toBe('row-0');
});

test('keeps a focused or selected reading row mounted until the interaction ends', () => {
  const fixture = setup(100_000);
  fixture.flush();
  fixture.setFollow(false);
  const row = fixture.rows()[fixture.rows().length - 1]!;
  row.querySelector('button')!.focus();
  fixture.host.scrollTop = 0;
  fixture.host.dispatchEvent(new Event('scroll'));
  fixture.flush();
  expect(row.isConnected).toBe(true);
  expect(fixture.rows().length).toBeLessThanOrEqual(251);
  expect(fixture.renderItem.mock.calls.length).toBeLessThan(500);
  expect(fixture.list.querySelector('[data-viewport-edge="gap"]')).not.toBeNull();
  expect(document.activeElement).toBe(row.querySelector('button'));
  (document.activeElement as HTMLElement).blur();
  const range = document.createRange();
  range.selectNodeContents(row.querySelector('button')!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  expect(document.getSelection()!.isCollapsed).toBe(false);
  fixture.handle.refresh();
  fixture.flush();
  expect(row.isConnected).toBe(true);
  expect(fixture.rows().length).toBeLessThanOrEqual(251);
  document.getSelection()!.removeAllRanges();
  fixture.handle.refresh();
  fixture.flush();
  expect(row.isConnected).toBe(false);
});

test('preserves the complete selected interval without mounting the gap to a distant viewport', () => {
  const fixture = setup(100_000);
  fixture.flush();
  fixture.setFollow(false);
  const tail = fixture.rows();
  const selectedRows = tail.slice(1, 5);
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.setStartBefore(selectedRows[0]);
  range.setEndAfter(selectedRows[selectedRows.length - 1]);
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();
  expect(selectedText).toContain(selectedRows[0].textContent!.trim());

  fixture.host.scrollTop = 0;
  fixture.host.dispatchEvent(new Event('scroll'));
  fixture.flush();

  expect(selectedRows.every(row => row.isConnected)).toBe(true);
  expect(selection.toString()).toBe(selectedText);
  expect(fixture.rows()[0].dataset.historyKey).toBe('row-0');
  expect(fixture.rows().length).toBeLessThanOrEqual(254);
  expect(fixture.renderItem.mock.calls.length).toBeLessThan(500);
  expect(fixture.list.querySelector('[data-viewport-edge="gap"]')).not.toBeNull();
});

test('a selection spanning the current viewport and a pinned tail does not mount their empty gap', () => {
  const fixture = setup(100_000);
  fixture.flush();
  fixture.setFollow(false);
  const tail = fixture.rows()[fixture.rows().length - 1];
  const button = tail.querySelector('button')!;
  button.focus();
  fixture.host.scrollTop = 0;
  fixture.host.dispatchEvent(new Event('scroll'));
  fixture.flush();
  const head = fixture.rows()[0];
  expect(head.dataset.historyKey).toBe('row-0');
  expect(tail.isConnected).toBe(true);

  const range = document.createRange();
  range.setStartBefore(head);
  range.setEndAfter(tail);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();
  fixture.handle.refresh();
  fixture.flush();

  expect(fixture.rows().length).toBeLessThanOrEqual(251);
  expect(fixture.renderItem.mock.calls.length).toBeLessThan(500);
  expect(fixture.list.querySelector('[data-history-key="row-50000"]')).toBeNull();
  expect(fixture.list.querySelector('[data-viewport-edge="gap"]')).not.toBeNull();
  expect(head.isConnected).toBe(true);
  expect(tail.isConnected).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(selection.toString()).toBe(selectedText);
});

test('disconnect cancels frame work and reconnect refreshes the same owner', () => {
  const fixture = setup();
  expect(fixture.frames.size).toBe(1);
  fixture.part.setConnected(false);
  expect(fixture.frames.size).toBe(0);
  fixture.before.mockClear();
  fixture.host.dispatchEvent(new Event('scroll'));
  expect(fixture.frames.size).toBe(0);
  expect(fixture.before).not.toHaveBeenCalled();
  fixture.part.setConnected(true);
  expect(fixture.frames.size).toBe(1);
  fixture.flush();
});

test('repeated materialization of unchanged rows does not keep scheduling layout frames', () => {
  const fixture = setup();
  fixture.flush();
  expect(fixture.frames.size).toBe(0);
  for (let materialization = 0; materialization < 30; materialization += 1) {
    fixture.commit();
    expect(fixture.frames.size).toBe(0);
  }
});

test.each([false, true])(
  'retains closed disclosure editors during scroll and resize (outer across shadow: %s)',
  outerAcrossShadow => {
    let resize = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const fixture = setup(1_000, { disclosures: true, outerAcrossShadow });
    fixture.flush();
    fixture.setFollow(false);
    fixture.handle.reveal('row-500');
    fixture.host.scrollTop = fixture.handle.offsetFor('row-500')!;
    fixture.host.dispatchEvent(new Event('scrollend'));
    fixture.flush();
    const row = fixture.list.querySelector('[data-history-key="row-500"]')!;
    const editor = document.createElement('textarea');
    editor.value = 'Unsubmitted editor state';
    row.append(editor);
    const closed = outerAcrossShadow ? fixture.outerDetails : fixture.details;
    closed.open = false;
    closed.dispatchEvent(new Event('toggle'));
    fixture.before.mockClear();
    fixture.after.mockClear();
    fixture.renderItem.mockClear();

    fixture.host.dispatchEvent(new Event('scroll'));
    resize();
    fixture.flush();

    expect(row.isConnected).toBe(true);
    expect(editor.value).toBe('Unsubmitted editor state');
    expect(fixture.renderItem).not.toHaveBeenCalled();
    expect(fixture.before).not.toHaveBeenCalled();
    expect(fixture.after).not.toHaveBeenCalled();
    fixture.commit();
    expect(row.isConnected).toBe(true);
    expect(editor.value).toBe('Unsubmitted editor state');
    expect(fixture.frames.size).toBe(0);

    fixture.host.scrollTop = 0;
    closed.open = true;
    closed.dispatchEvent(new Event('toggle'));
    expect(fixture.frames.size).toBe(1);
    fixture.flush();
    expect(fixture.rows()[0].dataset.historyKey).toBe('row-0');
    expect(row.isConnected).toBe(false);
    fixture.part.setConnected(false);
  },
);

test('explicitly reveals a search target while its enclosing disclosures are closed', () => {
  const fixture = setup(1_000, { disclosures: true, outerAcrossShadow: true });
  fixture.flush();
  fixture.setFollow(false);
  fixture.outerDetails.open = false;
  fixture.details.open = false;
  fixture.outerDetails.dispatchEvent(new Event('toggle'));
  fixture.details.dispatchEvent(new Event('toggle'));
  expect(fixture.handle.reveal('row-500')).toBe(true);
  const target = fixture.list.querySelector('[data-history-key="row-500"]')!;
  expect(target).not.toBeNull();
  fixture.flush();
  expect(fixture.frames.size).toBe(0);

  fixture.details.open = true;
  fixture.details.dispatchEvent(new Event('toggle'));
  expect(fixture.frames.size).toBe(0);
  fixture.outerDetails.open = true;
  fixture.outerDetails.dispatchEvent(new Event('toggle'));
  fixture.flush();
  expect(target.isConnected).toBe(true);
  fixture.host.scrollTop = fixture.handle.offsetFor('row-500')!;
  fixture.host.dispatchEvent(new Event('scrollend'));
  fixture.flush();
  expect(fixture.visibleRow()?.dataset.historyKey).toBe('row-500');
  fixture.part.setConnected(false);
});

test('replaces coincident row keys when the native presentation scope changes', () => {
  const fixture = setup(3);
  const oldRows = fixture.rows();
  fixture.commit('different-physical-session');
  expect(fixture.rows()).toHaveLength(3);
  expect(oldRows.every(row => !row.isConnected)).toBe(true);
});

test('keeps list containers valid with list-item rows and presentation-only spacers', () => {
  const host = document.createElement('div');
  const list = document.createElement('ol');
  host.append(list);
  document.body.append(host);
  render(
    historyViewport({
      items: ['one', 'two'],
      key: item => item,
      render: item => item,
      host,
      scope: 'list-scope',
      rowTag: 'li',
    }),
    list,
  );
  expect([...list.children].every(element => element.tagName === 'LI')).toBe(true);
  expect(list.querySelectorAll('.history-viewport-row')).toHaveLength(2);
  expect(list.querySelectorAll('li[role="presentation"]')).toHaveLength(2);
});

test('schedules layout work in the actual owner window', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const owner = frame.contentWindow!;
  const host = owner.document.createElement('div');
  const list = owner.document.createElement('div');
  host.append(list);
  owner.document.body.append(host);
  const mainFrame = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', mainFrame);
  const ownerFrame = vi.spyOn(owner, 'requestAnimationFrame').mockImplementation(() => 2);
  render(
    historyViewport({
      items: ['owned-row'],
      key: item => item,
      render: item => item,
      host,
      scope: 'owned-document',
    }),
    list,
  );
  expect(ownerFrame).toHaveBeenCalledOnce();
  expect(mainFrame).not.toHaveBeenCalled();
});
