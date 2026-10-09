// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CoworkDisplayPanel, { type CoworkDisplayTab } from './CoworkDisplayPanel';

let clusterWidth = 416;
let actionsWidth = 32;
const observers: { callback: ResizeObserverCallback; instance: ResizeObserver }[] = [];

const labels = ['网页搜索', 'A very long document title.md', 'Terminal', 'Plan', 'Review', 'Image'];

function tabs(count = labels.length): CoworkDisplayTab[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    label: labels[index] ?? `Tab ${index + 1}`,
    icon: <span>{index}</span>,
    onSelect: vi.fn(),
    onClose: vi.fn(),
  }));
}

function TabHarness({
  count = labels.length,
  isOpen = true,
}: {
  count?: number;
  isOpen?: boolean;
}) {
  const [activeTabId, setActiveTabId] = useState('tab-0');
  return (
    <CoworkDisplayPanel
      activeTabId={activeTabId}
      isOpen={isOpen}
      onClose={vi.fn()}
      actions={<button>New page</button>}
      tabs={tabs(count).map(tab => ({ ...tab, onSelect: () => setActiveTabId(tab.id) }))}
    >
      <div>Content</div>
    </CoworkDisplayPanel>
  );
}

function rect(left: number, width: number, top = 20, height = 35): DOMRect {
  return {
    x: left,
    y: top,
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  clusterWidth = 416;
  actionsWidth = 32;
  observers.length = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.testid === 'display-tab-cluster') return clusterWidth;
    if (this.classList.contains('cowork-display-tab-scroller')) {
      const listButton = this.parentElement?.querySelector('.cowork-display-tab-list-button');
      return Math.min(
        parseFloat(this.style.width),
        clusterWidth - actionsWidth - (listButton ? 32 : 0),
      );
    }
    return this.id === 'cowork-display-panel' ? 520 : 1_200;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('cowork-display-tab-scroller')
      ? parseFloat(this.style.width)
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'menu' ? this.children.length * 32 + 14 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('cowork-display-tab')) {
      const scroller = this.parentElement!;
      const index = Array.from(scroller.children).indexOf(this);
      const width = parseFloat(this.style.width);
      return rect(100 + index * width - scroller.scrollLeft, width);
    }
    if (this.classList.contains('cowork-display-tab-scroller')) return rect(100, this.clientWidth);
    if (
      this.contains(screen.queryByRole('button', { name: 'New page' })) &&
      this.children.length === 1
    ) {
      return rect(100 + clusterWidth - actionsWidth, actionsWidth);
    }
    return rect(100, 32);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, instance: this as unknown as ResizeObserver });
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resize(width: number) {
  clusterWidth = width;
  act(() => observers.slice().forEach(observer => observer.callback([], observer.instance)));
}

function tabWidths() {
  return screen.getAllByRole('tab').map(tab => parseFloat(tab.parentElement!.style.width));
}

function setupTabListMeasurements() {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'menu'
      ? Math.min(this.scrollHeight, parseFloat(this.style.maxHeight) - 2)
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'menuitemradio'
      ? Array.from(this.parentElement!.children).indexOf(this) * 32 + 6
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'menuitemradio' ? 32 : 0;
  });
}

function expectFocusedItemVisible(menu: HTMLElement, item: HTMLElement) {
  expect(document.activeElement).toBe(item);
  expect(item.offsetTop).toBeGreaterThanOrEqual(menu.scrollTop);
  expect(item.offsetTop + item.offsetHeight).toBeLessThanOrEqual(
    menu.scrollTop + menu.clientHeight,
  );
}

describe('sidebar tab layout', () => {
  it('allocates equal widths independent of title length, then shrinks before overflowing', () => {
    const view = render(<TabHarness count={2} />);
    expect(tabWidths()).toEqual([192, 192]);
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();

    view.rerender(<TabHarness count={4} />);
    expect(tabWidths()).toEqual([96, 96, 96, 96]);
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();
    expect(screen.getByRole('tab', { name: labels[1] }).title).toBe(labels[1]);

    resize(384);
    expect(tabWidths()).toEqual([88, 88, 88, 88]);
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();
    resize(383);
    expect(tabWidths()).toEqual([88, 88, 88, 88]);
    expect(screen.getByRole('button', { name: 'All tabs' })).toBeTruthy();
    resize(383);
    expect(screen.getByRole('button', { name: 'All tabs' })).toBeTruthy();
    resize(384);
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();
    resize(1_200);
    expect(tabWidths()).toEqual([192, 192, 192, 192]);
  });

  it('remeasures when fixed actions change width or appear', () => {
    const panel = (actions?: React.ReactNode) => (
      <CoworkDisplayPanel
        activeTabId="tab-0"
        isOpen
        onClose={vi.fn()}
        tabs={tabs(4)}
        actions={actions}
      >
        Content
      </CoworkDisplayPanel>
    );
    const view = render(panel());
    expect(tabWidths()).toEqual([104, 104, 104, 104]);
    view.rerender(panel(<button>New page</button>));
    expect(tabWidths()).toEqual([96, 96, 96, 96]);
    actionsWidth = 80;
    resize(416);
    expect(screen.getByRole('button', { name: 'All tabs' })).toBeTruthy();
  });

  it('reveals the selected tab after switching, resizing, and changing the tab count', async () => {
    const view = render(<TabHarness />);
    const scroller = screen.getByRole('tablist');
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    await waitFor(() => expect(scroller.scrollLeft).toBe(176));
    resize(340);
    await waitFor(() => expect(scroller.scrollLeft).toBe(252));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Image' }), { key: 'Home' });
    await waitFor(() => expect(scroller.scrollLeft).toBe(0));
    expect(screen.getByRole('tab', { name: labels[0] }).getAttribute('aria-selected')).toBe('true');
    view.rerender(<TabHarness count={3} />);
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();
    expect(tabWidths()).toEqual([102, 102, 102]);
  });

  it('scrolls the strip with a mouse wheel without intercepting zoom or horizontal gestures', () => {
    render(<TabHarness />);
    const scroller = screen.getByRole('tablist');
    const wheel = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true });
    fireEvent(scroller, wheel);
    expect(scroller.scrollLeft).toBe(60);
    expect(wheel.defaultPrevented).toBe(true);
    fireEvent.wheel(scroller, { deltaY: 60, ctrlKey: true });
    fireEvent.wheel(scroller, { deltaX: 60, deltaY: 1 });
    expect(scroller.scrollLeft).toBe(60);
  });

  it('keeps tabs mounted and waits for a measurable width when the sidebar is hidden', () => {
    const view = render(<TabHarness />);
    const scroller = screen.getByRole('tablist');
    view.rerender(<TabHarness isOpen={false} />);
    resize(0);
    expect(scroller.children).toHaveLength(6);
    expect(screen.queryByRole('menu')).toBeNull();
    view.rerender(<TabHarness />);
    resize(416);
    expect(tabWidths()).toEqual([88, 88, 88, 88, 88, 88]);
  });
});

describe('all sidebar tabs menu', () => {
  it('reflows and dismisses the overflow menu when entering fullscreen, then restores the narrow strip', () => {
    render(<TabHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
    clusterWidth = 900;
    fireEvent.click(screen.getByRole('button', { name: 'Fill workspace' }));
    expect(tabWidths()).toEqual([144, 144, 144, 144, 144, 144]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();
    clusterWidth = 416;
    fireEvent.click(screen.getByRole('button', { name: 'Restore sidebar size' }));
    expect(tabWidths()).toEqual([88, 88, 88, 88, 88, 88]);
    expect(screen.getByRole('button', { name: 'All tabs' })).toBeTruthy();
  });

  it('lists peer tabs in order, focuses the selected item, and selects through the existing callback', async () => {
    render(<TabHarness />);
    const trigger = screen.getByRole('button', { name: 'All tabs' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'All tabs' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map(item => item.title)).toEqual(labels);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(items[0]);
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[5]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[5]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(items[5]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Image' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Image' })),
    );
    expect(screen.getByRole('tablist').scrollLeft).toBe(176);
  });

  it('restores focus on Escape, Tab and outside click, and dismisses on hide or overflow recovery', () => {
    const view = render(<TabHarness />);
    const trigger = screen.getByRole('button', { name: 'All tabs' });
    for (const key of ['Escape', 'Tab']) {
      fireEvent.click(trigger);
      fireEvent.keyDown(screen.getByRole('menu'), { key });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText('Close tab list'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    resize(600);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: labels[0] }));
    resize(416);
    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
    view.rerender(<TabHarness isOpen={false} />);
    expect(screen.queryByRole('menu')).toBeNull();
    view.rerender(<TabHarness />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('clamps the complete menu inside a narrow, short viewport', () => {
    vi.stubGlobal('innerWidth', 240);
    vi.stubGlobal('innerHeight', 160);
    render(
      <CoworkDisplayPanel activeTabId="tab-1" isOpen onClose={vi.fn()} tabs={tabs()}>
        Content
      </CoworkDisplayPanel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
    const menu = screen.getByRole('menu');
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(
      window.innerWidth - 8,
    );
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 16);
    expect(parseFloat(menu.style.top) + parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(
      window.innerHeight - 8,
    );
  });

  it('reveals a late selected item after opening the list in a short viewport', () => {
    setupTabListMeasurements();
    vi.stubGlobal('innerWidth', 240);
    vi.stubGlobal('innerHeight', 160);
    render(
      <CoworkDisplayPanel activeTabId="tab-11" isOpen onClose={vi.fn()} tabs={tabs(12)}>
        Content
      </CoworkDisplayPanel>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));

    const menu = screen.getByRole('menu', { name: 'All tabs' });
    const selectedItem = within(menu).getByRole('menuitemradio', { name: 'Tab 12' });
    expect(parseFloat(menu.style.maxHeight)).toBe(144);
    expectFocusedItemVisible(menu, selectedItem);
  });

  it('keeps the keyboard-focused item visible when an open list shrinks with the viewport', () => {
    setupTabListMeasurements();
    vi.stubGlobal('innerHeight', 800);
    render(<TabHarness count={12} />);
    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
    const menu = screen.getByRole('menu', { name: 'All tabs' });
    const focusedItem = within(menu).getByRole('menuitemradio', { name: 'Tab 12' });
    fireEvent.keyDown(menu, { key: 'End' });
    expectFocusedItemVisible(menu, focusedItem);

    vi.stubGlobal('innerHeight', 160);
    fireEvent(window, new Event('resize'));

    expect(screen.getByRole('menu', { name: 'All tabs' })).toBe(menu);
    expect(parseFloat(menu.style.maxHeight)).toBe(144);
    expect(within(menu).getAllByRole('menuitemradio')[0].getAttribute('aria-checked')).toBe('true');
    expectFocusedItemVisible(menu, focusedItem);
  });

  it('dismisses the portaled list when an ancestor hides the still-open panel', () => {
    const view = render(<TabHarness />);
    const trigger = screen.getByRole('button', { name: 'All tabs' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'All tabs' })).toBeTruthy();
    expect(screen.getByLabelText('Close tab list')).toBeTruthy();

    view.container.style.display = 'none';
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(100, 0, 20, 0));
    resize(clusterWidth);

    expect(trigger.closest('aside')?.getAttribute('aria-hidden')).toBe('false');
    expect(screen.queryByRole('menu', { name: 'All tabs' })).toBeNull();
    expect(screen.queryByLabelText('Close tab list')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });

  it('preserves manual list scrolling and focus when peer titles update', () => {
    setupTabListMeasurements();
    vi.stubGlobal('innerHeight', 800);
    const panel = (updated: boolean) => (
      <CoworkDisplayPanel
        activeTabId="tab-0"
        isOpen
        onClose={vi.fn()}
        tabs={tabs(24).map(tab => ({
          ...tab,
          label: updated ? `${tab.label} updated` : tab.label,
        }))}
      >
        Content
      </CoworkDisplayPanel>
    );
    const view = render(panel(false));
    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
    const menu = screen.getByRole('menu', { name: 'All tabs' });
    const focusedItem = within(menu).getAllByRole('menuitemradio')[0];
    expect(document.activeElement).toBe(focusedItem);
    menu.scrollTop = 256;
    fireEvent.scroll(menu);

    view.rerender(panel(true));

    expect(screen.getByRole('menu', { name: 'All tabs' })).toBe(menu);
    expect(focusedItem.title).toBe(`${labels[0]} updated`);
    expect(document.activeElement).toBe(focusedItem);
    expect(menu.scrollTop).toBe(256);
  });
});
