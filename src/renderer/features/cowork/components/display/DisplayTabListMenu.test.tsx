// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import DisplayTabListMenu from './DisplayTabListMenu';

afterEach(() => {
  cleanup();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('positions the tab list, focuses and navigates within the workspace document', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const childDocument = frame.contentDocument!;
  const childWindow = frame.contentWindow! as Window & typeof globalThis;
  const sourceResizeObserver = vi.fn();
  vi.stubGlobal('ResizeObserver', sourceResizeObserver);
  const observedElements: Element[] = [];
  Object.defineProperty(childWindow, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe(element: Element) {
        observedElements.push(element);
      }
      disconnect() {}
    },
  });
  Object.defineProperty(childWindow, 'innerWidth', { configurable: true, value: 260 });
  Object.defineProperty(childWindow, 'innerHeight', { configurable: true, value: 180 });
  const anchor = childDocument.createElement('button');
  childDocument.body.append(anchor);
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
    left: 220,
    right: 252,
    top: 8,
    bottom: 40,
    width: 32,
    height: 32,
    x: 220,
    y: 8,
    toJSON: () => ({}),
  });
  const onSelect = vi.fn();
  const onDismiss = vi.fn();
  const tabs = ['Browser', 'agent-team', 'Swarm Workflow'].map(label => ({
    id: label,
    label,
    icon: null,
    onSelect: vi.fn(),
  }));

  render(
    <OwnerDocumentContext.Provider value={childDocument}>
      <DisplayTabListMenu
        id="workspace-tab-list"
        activeTabId="agent-team"
        anchor={anchor}
        tabs={tabs}
        onDismiss={onDismiss}
        onSelect={onSelect}
      />
    </OwnerDocumentContext.Provider>,
  );

  const menu = childDocument.querySelector<HTMLElement>('[role="menu"]')!;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(menu.style.width).toBe('244px');
  expect(menu.style.left).toBe('8px');
  expect(menu.style.maxHeight).toBe('164px');
  expect(observedElements).toEqual([anchor, menu]);
  expect(sourceResizeObserver).not.toHaveBeenCalled();
  expect(childDocument.activeElement).toBe(items[1]);
  expect(items[1] instanceof HTMLButtonElement).toBe(false);

  fireEvent.keyDown(menu, { key: 'End' });
  expect(childDocument.activeElement).toBe(items[2]);
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(childDocument.activeElement).toBe(items[0]);
  fireEvent.click(items[2]);
  expect(onSelect).toHaveBeenCalledWith(tabs[2]);
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(onDismiss).toHaveBeenCalledOnce();

  Object.defineProperty(childWindow, 'innerWidth', { configurable: true, value: 220 });
  fireEvent(childWindow, new childWindow.Event('resize'));
  expect(menu.style.width).toBe('204px');
  expect(onDismiss).toHaveBeenCalledOnce();
});
