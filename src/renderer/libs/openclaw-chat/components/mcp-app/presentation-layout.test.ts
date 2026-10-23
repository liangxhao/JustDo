// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import type { NativePresentationSurface } from '@/shared/dom/nativePresentationSurface';

import {
  type NativeWidgetPresentation,
  NativeWidgetPresentations,
} from '../native-widget/presentations';
import { type McpAppPresentation, McpAppPresentations } from './presentations';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const doc = frame.contentDocument!;
  const owner = frame.contentWindow! as Window & typeof globalThis;
  const pending = new Map<number, () => void>();
  let sequence = 0;
  owner.setTimeout = ((callback: TimerHandler) => {
    const id = ++sequence;
    if (typeof callback === 'function') pending.set(id, () => callback());
    return id;
  }) as typeof owner.setTimeout;
  owner.clearTimeout = id => {
    pending.delete(Number(id));
  };
  const apps = new McpAppPresentations(doc);
  const widgets = new NativeWidgetPresentations(doc);
  let visible = true;
  let width = 480;
  const target = doc.createElement('div');
  const rect = () => new DOMRect(20, 40, width, 400);
  vi.spyOn(target, 'getBoundingClientRect').mockImplementation(rect);
  vi.spyOn(target, 'getClientRects').mockImplementation(
    () => (visible ? [rect()] : []) as unknown as DOMRectList,
  );
  doc.body.append(target);
  const makeLayer = () => {
    const layer = doc.createElement('div');
    doc.body.append(layer);
    return layer;
  };
  // Real document observers and layout controllers exercise their interaction;
  // protocol/view loading is independent of this geometry-only regression.
  const app = {
    layer: makeLayer(),
    primary: target,
    pinned: false,
    height: 400,
    view: { context: { isCurrent: () => true }, expanded: false },
  } as unknown as McpAppPresentation;
  const widget = {
    layer: makeLayer(),
    primary: target,
    pinned: false,
    height: 400,
    visible: false,
    view: {
      context: { isCurrent: () => true },
      expanded: false,
      refreshPresentation: vi.fn(),
    },
  } as unknown as NativeWidgetPresentation;
  apps.entries.push(app);
  widgets.entries.push(widget);
  const mutations: MutationRecord[] = [];
  const observer = new owner.MutationObserver(records => mutations.push(...records));
  observer.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['style'] });
  const flushMutations = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const settle = async () => {
    await flushMutations();
    for (let attempt = 0; attempt < 8 && pending.size; attempt++) {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach(callback => callback());
      await flushMutations();
    }
    expect(pending.size, 'Retained surface observers must stop scheduling stable geometry').toBe(0);
  };
  return {
    apps,
    widgets,
    app,
    widget,
    mutations,
    settle,
    flushMutations,
    resize() {
      width = 620;
      target.style.width = `${width}px`;
    },
    hide() {
      visible = false;
      target.style.display = 'none';
    },
    dispose: () => observer.disconnect(),
  };
}

test('MCP App and widget layout observers settle together and still respond to source geometry', async () => {
  const f = fixture();
  try {
    f.apps.requestLayout();
    f.widgets.requestLayout();
    await f.settle();
    expect(f.app.layer.style.width).toBe('480px');
    expect(f.widget.layer.style.width).toBe('480px');
    f.mutations.length = 0;

    f.apps.layout();
    f.widgets.layout();
    await f.flushMutations();
    expect(f.mutations, 'Identical geometry must not emit fresh body style mutations').toHaveLength(
      0,
    );
    await f.settle();

    f.resize();
    await f.settle();
    expect(f.app.layer.style.width).toBe('620px');
    expect(f.widget.layer.style.width).toBe('620px');
  } finally {
    f.dispose();
  }
});

test('repeated hidden layouts do not mutate either retained surface', async () => {
  const f = fixture();
  try {
    f.apps.requestLayout();
    f.widgets.requestLayout();
    await f.settle();
    f.hide();
    await f.settle();
    expect(f.app.layer.style.display).toBe('none');
    expect(f.widget.layer.style.display).toBe('none');
    f.mutations.length = 0;

    f.apps.layout();
    f.widgets.layout();
    await f.flushMutations();
    expect(f.mutations, 'Hidden surfaces must not wake each other repeatedly').toHaveLength(0);
    await f.settle();
  } finally {
    f.dispose();
  }
});

test('an expanded native App under a modal does not repeatedly publish and remove its own overlay', async () => {
  const f = fixture();
  const doc = f.app.layer.ownerDocument;
  const modal = doc.createElement('div');
  modal.dataset.workspaceOverlay = 'true';
  vi.spyOn(modal, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 800, 600),
  ] as unknown as DOMRectList);
  doc.body.append(modal);
  let overlay: HTMLElement | undefined;
  const setExpanded = vi.fn((owner?: Document) => {
    if (overlay?.ownerDocument === owner) return;
    overlay?.remove();
    overlay = undefined;
    if (owner) {
      overlay = owner.createElement('div');
      overlay.dataset.workspaceOverlay = 'true';
      owner.body.append(overlay);
    }
  });
  f.app.surface = {
    ready: true,
    get overlay() {
      return overlay;
    },
    setExpanded,
    hide: () => {
      overlay?.remove();
      overlay = undefined;
    },
    present: vi.fn(),
  } as unknown as NativePresentationSurface;
  f.app.view.expanded = true;
  f.apps.requestLayout();
  await f.settle();
  expect(f.app.visible).toBe(false);
  expect(setExpanded).not.toHaveBeenCalled();
  expect(doc.querySelectorAll('[data-workspace-overlay="true"]')).toHaveLength(1);
  f.dispose();
});
