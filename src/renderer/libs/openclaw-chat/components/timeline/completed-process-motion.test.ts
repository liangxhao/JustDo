/** @vitest-environment jsdom */

import { html, render } from 'lit';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CompletedProcessTimelineItem } from '../../model/timeline/timeline-avatar-state';
import { CompletedProcessMotion } from './completed-process-motion';
import { disclosureContent } from './disclosure-content';

const controllers: CompletedProcessMotion[] = [];
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal('CSS', { supports: () => true });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
});

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.reset(null));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function group(key = 'completed-process:summary', summaryKey = 'summary'): CompletedProcessTimelineItem {
  return {
    kind: 'completed-process',
    key,
    items: [{
      kind: 'process-summary',
      key: summaryKey,
      runId: 'run',
      thinkingCount: 1,
      toolCount: 0,
      errorCount: 0,
      interruptedCount: 0,
      items: [{
        type: 'thinking',
        id: 'native-thinking',
        runId: 'run',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
        status: 'completed',
        text: 'Inspect configuration.',
      }],
    }],
  };
}

function fixture() {
  const host = document.createElement('div');
  const root = document.createElement('div');
  host.append(root);
  document.body.append(host);
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 500));
  const motion = new CompletedProcessMotion(host);
  controllers.push(motion);
  motion.reset('session:physical:generation');
  return {
    host,
    root,
    motion,
    source(markup = '<span data-process-summary-key="summary"></span>', top = 20, height = 180) {
      const row = document.createElement('div');
      row.className = 'chat-group';
      row.innerHTML = markup;
      root.append(row);
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 640, height));
      return row;
    },
    mount(item = group(), expanded = false) {
      const container = document.createElement('div');
      root.replaceChildren(container);
      const contents = vi.fn(() => html`<p>Existing process content</p>`);
      render(html`<details class="completed-process" ?open=${expanded}>
        <summary>Process</summary><div class="process-disclosure-content">${disclosureContent(contents)}</div>
      </details>`, container);
      const details = container.querySelector('details')!;
      const body = details.querySelector<HTMLElement>('.process-disclosure-content')!;
      vi.spyOn(details, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 20, 640, 38));
      vi.spyOn(details.querySelector('summary')!, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 20, 640, 38));
      motion.ref(item, expanded)(details);
      return { details, body, contents };
    },
  };
}

function nextFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach(callback => callback(16));
}

test('keeps initial closed history lazy instead of playing a collapse on insertion', () => {
  const view = fixture();
  view.motion.capture(view.root);
  const { details, contents } = view.mount();
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(contents).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

test('bridges a previously visible source once while keeping its contents closed and lazy', () => {
  const view = fixture();
  view.source();
  view.motion.capture(view.root);
  const { details, contents } = view.mount();
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(details.hasAttribute('data-process-auto-fold')).toBe(true);
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('180px');
  expect(contents).not.toHaveBeenCalled();

  // A clock/history tick while staging must neither restart nor consume the close.
  view.motion.capture(view.root);
  view.motion.ref(group(), false)(details);
  view.motion.afterRender();
  expect(frames.size).toBe(1);
  nextFrame();
  expect(details.open).toBe(false);
  expect(details.hasAttribute('data-process-auto-fold')).toBe(true);
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('38px');
  expect(contents).not.toHaveBeenCalled();
  view.motion.afterRender();
  expect(frames.size).toBe(0);
});

test('matches streaming Thinking by exact typed identity across summary key changes', () => {
  const view = fixture();
  const row = view.source();
  row.replaceChildren();
  row.classList.add('chat-group--streaming-thinking');
  row.dataset.liveProcessId = 'native-thinking';
  view.motion.capture(view.root);
  const { details } = view.mount(group('new-shape', 'different-summary-key'));
  view.motion.afterRender();
  expect(details.hasAttribute('data-process-auto-fold')).toBe(true);
  nextFrame();

  // A later key shape containing the same source must not replay its collapse.
  view.source('<span class="process-summary__item--thinking" data-inline-process-id="native-thinking"></span>');
  view.motion.capture(view.root);
  const returning = view.mount(group('another-shape', 'another-summary-key'));
  view.motion.afterRender();
  expect(returning.details.open).toBe(false);
  expect(returning.contents).not.toHaveBeenCalled();
});

test('counts the visible summary of a closed live process disclosure', () => {
  const view = fixture();
  view.source('<details class="process-summary-group"><summary data-process-summary-key="summary">Thinking × 1</summary><div>Hidden details</div></details>');
  view.motion.capture(view.root);
  const { details } = view.mount();
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('180px');
});

test('bridges renamed closed summaries only through their exact typed native tail', () => {
  const view = fixture();
  view.source('<details class="process-summary-group"><summary data-process-summary-key="live-shape" data-process-summary-tail=\'["thinking","native-thinking"]\'>Thinking × 1</summary></details>');
  view.motion.capture(view.root);
  const { details } = view.mount(group('history-group', 'history-folded-summary'));
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('180px');
});

test('includes the enclosing open summary when only an inner native process ID survives', () => {
  const view = fixture();
  const row = view.source(`<details class="process-summary-group" open>
    <summary data-process-summary-key="old-summary">Thinking × 1</summary>
    <div class="chat-group process-summary__item--thinking">
      <span data-inline-process-id="native-thinking">Thinking details</span>
    </div>
  </details>`);
  vi.spyOn(row.querySelector('.chat-group')!, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 60, 640, 100));
  view.motion.capture(view.root);
  const { details } = view.mount(group('new-shape', 'new-summary'));
  view.motion.afterRender();
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('180px');
  nextFrame();
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('38px');
});

test('uses all mounted source bounds while requiring a source to intersect the viewport', () => {
  const view = fixture();
  view.source('<span data-process-summary-key="summary"></span>', -100, 80);
  view.source('<span data-message-disclosure-owner=\'["content-key",0,0]\'></span>', 20, 180);
  view.motion.capture(view.root);
  const item = group();
  const summary = item.items[0];
  if (summary.kind !== 'process-summary') throw new Error('Missing process summary');
  const { details } = view.mount({ ...item, items: [...item.items, {
    kind: 'content', key: 'content-key',
    item: { ...summary.items[0], type: 'content', status: 'completed', text: 'Content', sourceMode: 'snapshot' },
  }] });
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('300px');
});

test('does not equate a Tool and Thinking with the same native ID', () => {
  const view = fixture();
  view.source('<span class="process-live--tool" data-live-process-id="native-thinking"></span>');
  view.motion.capture(view.root);
  const { details, contents } = view.mount(group('new-shape', 'different-summary-key'));
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(contents).not.toHaveBeenCalled();
});

test('reads exact content owner tuples', () => {
  const view = fixture();
  view.source('<span data-message-disclosure-owner=\'["content-key",0,0]\'></span>');
  view.motion.capture(view.root);
  const item = group();
  const summary = item.items[0];
  if (summary.kind !== 'process-summary') throw new Error('Missing process summary');
  const { details } = view.mount({ ...item, items: [{
    kind: 'content',
    key: 'content-key',
    item: { ...summary.items[0], type: 'content', status: 'completed', text: 'Content', sourceMode: 'snapshot' },
  }] });
  view.motion.afterRender();
  expect(details.hasAttribute('data-process-auto-fold')).toBe(true);
});

test('does not treat malformed content markers or hidden closed bodies as visible sources', () => {
  const view = fixture();
  view.source('<span data-message-disclosure-owner="summary"></span>');
  view.source('<details><summary>Other process</summary><div data-process-summary-key="summary">Hidden</div></details>');
  view.motion.capture(view.root);
  const { details, contents } = view.mount();
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(contents).not.toHaveBeenCalled();
});

test('ignores offscreen sources and sources inside an existing completed disclosure', () => {
  const view = fixture();
  view.source(undefined, 600);
  const nested = view.source();
  const parent = document.createElement('details');
  parent.className = 'completed-process';
  parent.open = true;
  nested.replaceWith(parent);
  parent.append(nested);
  view.motion.capture(view.root);
  const { contents } = view.mount();
  view.motion.afterRender();
  expect(contents).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

test.each(['manual', 'expanded'] as const)('%s expansion cancels a scheduled close without undoing openness', action => {
  const view = fixture();
  view.source();
  view.motion.capture(view.root);
  const { details } = view.mount();
  view.motion.afterRender();
  if (action === 'manual') view.motion.cancel(details);
  else view.motion.ref(group(), true);
  details.open = true;
  nextFrame();
  expect(details.open).toBe(true);
  expect(details.hasAttribute('data-process-auto-fold')).toBe(false);
  view.motion.afterRender();
  expect(frames.size).toBe(0);
});

test('scope reset closes transient state and revokes its scheduled frame', () => {
  const view = fixture();
  view.source();
  view.motion.capture(view.root);
  const { details } = view.mount();
  view.motion.afterRender();
  view.motion.reset('different-physical-session');
  expect(details.open).toBe(false);
  expect(details.hasAttribute('data-process-auto-fold')).toBe(false);
  expect(frames.size).toBe(0);
  const next = view.mount();
  view.motion.afterRender();
  expect(next.details.open).toBe(false);
});

test('continues a pending collapse through a same-key native history takeover', () => {
  const view = fixture();
  view.source();
  view.motion.capture(view.root);
  const first = view.mount();
  const callback = view.motion.ref(group(), false);
  view.motion.afterRender();
  callback(undefined);
  const next = view.mount();
  expect(view.motion.ref(group(), false)).toBe(callback);
  view.motion.afterRender();
  expect(first.details.open).toBe(false);
  expect(next.details.open).toBe(false);
  expect(next.details.hasAttribute('data-process-auto-fold')).toBe(true);
  expect(frames.size).toBe(1);
  nextFrame();
  expect(next.details.open).toBe(false);
});

test.each(['same-key', 'native-history-shape'] as const)(
  'transfers an ongoing close through %s replacement with its current size and original deadline',
  shape => {
    let now = 0;
    vi.spyOn(window.performance, 'now').mockImplementation(() => now);
    const view = fixture();
    view.source();
    view.motion.capture(view.root);
    const first = view.mount();
    view.motion.afterRender();
    nextFrame();
    expect(first.details.open).toBe(false);

    // The old CSS transition is still running 100ms after its close frame.
    now = 100;
    vi.mocked(first.details.getBoundingClientRect).mockReturnValue(new DOMRect(0, 20, 640, 60));
    view.motion.capture(view.root);
    view.motion.ref(group(), false)(undefined);
    const item = shape === 'same-key' ? group() : group('history-group', 'history-summary');
    const next = view.mount(item);
    view.motion.afterRender();
    expect(next.details.open).toBe(false);
    expect(next.details.style.getPropertyValue('--process-auto-fold-size')).toBe('60px');
    expect(next.details.style.getPropertyValue('--process-auto-fold-duration')).toBe('0ms');
    expect(next.contents).not.toHaveBeenCalled();

    now = 116;
    nextFrame();
    expect(next.details.open).toBe(false);
    expect(next.details.style.getPropertyValue('--process-auto-fold-duration')).toBe('124ms');
    const nested = new Event('transitionend', { bubbles: true });
    Object.defineProperty(nested, 'propertyName', { value: 'block-size' });
    next.body.dispatchEvent(nested);
    expect(next.details.style.getPropertyValue('--process-auto-fold-duration')).toBe('124ms');
    const completed = new Event('transitionend', { bubbles: true });
    Object.defineProperty(completed, 'propertyName', { value: 'block-size' });
    next.details.dispatchEvent(completed);
    expect(next.details.style.getPropertyValue('--process-auto-fold-duration')).toBe('');
    view.motion.afterRender();
    expect(frames.size).toBe(0);
  },
);

test('smoothly bridges a single short Thinking title to a taller closed header', () => {
  const view = fixture();
  view.source(undefined, 20, 28);
  view.motion.capture(view.root);
  const { details, contents } = view.mount();
  view.motion.afterRender();
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('28px');
  nextFrame();
  expect(details.style.getPropertyValue('--process-auto-fold-size')).toBe('38px');
  expect(details.open).toBe(false);
  expect(contents).not.toHaveBeenCalled();
});

test('does not schedule motion when the source already matches the closed header height', () => {
  const view = fixture();
  view.source(undefined, 20, 38);
  view.motion.capture(view.root);
  const { details, contents } = view.mount();
  view.motion.afterRender();
  expect(details.hasAttribute('data-process-auto-fold')).toBe(false);
  expect(contents).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

test('drops disconnected registrations without replaying their settled source on remount', () => {
  const view = fixture();
  const first = view.mount();
  view.motion.afterRender();
  const callback = view.motion.ref(group(), false);
  callback(undefined);
  view.root.replaceChildren();
  view.motion.afterRender();
  expect(view.motion.ref(group(), false)).not.toBe(callback);
  view.source();
  view.motion.capture(view.root);
  const next = view.mount();
  view.motion.afterRender();
  expect(first.details.open).toBe(false);
  expect(next.details.open).toBe(false);
});

test('leaves unsupported renderers lazy and cancels transient work on disconnect', () => {
  const view = fixture();
  view.source();
  view.motion.capture(view.root);
  const { details, contents } = view.mount();
  vi.stubGlobal('CSS', { supports: () => false });
  view.motion.afterRender();
  expect(details.open).toBe(false);
  expect(contents).not.toHaveBeenCalled();

  vi.stubGlobal('CSS', { supports: () => true });
  const active = fixture();
  active.source();
  active.motion.capture(active.root);
  const transient = active.mount();
  active.motion.afterRender();
  active.host.remove();
  nextFrame();
  expect(transient.details.open).toBe(false);
  expect(transient.details.hasAttribute('data-process-auto-fold')).toBe(false);
});
