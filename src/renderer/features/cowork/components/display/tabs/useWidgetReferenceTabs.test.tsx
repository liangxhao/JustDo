// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  getNativeWidgetPresentations,
  type NativeWidgetPresentation,
} from '@/libs/openclaw-chat/components/native-widget/presentations';

import { useWidgetReferenceTabs } from './useWidgetReferenceTabs';

beforeEach(() => {
  vi.spyOn(getNativeWidgetPresentations(), 'requestLayout').mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 10));
  vi.restoreAllMocks();
});

test('retains the active scope until leaving a deleted conversation', () => {
  const manager = getNativeWidgetPresentations();
  const dispose = vi.fn();
  manager.entries.push({
    id: 'widget-one',
    scope: 'current',
    pinned: true,
    returnPending: false,
    anchors: new Set(),
    layer: document.createElement('div'),
    context: { presentationScope: 'current' },
    preview: { title: 'Chart' },
    visible: false,
    view: { context: { isCurrent: () => true }, refreshPresentation: vi.fn() },
    dispose,
  } as unknown as NativeWidgetPresentation);
  const { result, rerender } = renderHook(
    ({ scope, ids }) => useWidgetReferenceTabs(scope, vi.fn(), vi.fn(), ids),
    { initialProps: { scope: 'current', ids: ['older'] } },
  );
  expect(result.current.tabs.map(tab => tab.id)).toEqual(['widget-one']);
  expect(result.current.tabs[0].reference).toBe(true);
  expect(result.current.hasRetainedPanels).toBe(true);
  rerender({ scope: 'current', ids: [] });
  expect(dispose).not.toHaveBeenCalled();
  rerender({ scope: 'another', ids: ['another'] });
  expect(result.current.tabs).toHaveLength(0);
  expect(dispose).toHaveBeenCalledOnce();
});

test('reveals only the current conversation and closes through unpin', () => {
  const manager = getNativeWidgetPresentations();
  let reveal: (entry: NativeWidgetPresentation) => void = () => undefined;
  vi.spyOn(manager, 'onReveal').mockImplementation(listener => {
    reveal = listener;
    return () => undefined;
  });
  const unpin = vi.spyOn(manager, 'unpin').mockImplementation(() => undefined);
  const select = vi.fn();
  const open = vi.fn();
  const entry = {
    id: 'widget-one',
    scope: 'current',
    pinned: true,
    preview: { title: 'Chart' },
    anchors: new Set(),
    layer: document.createElement('div'),
    context: { presentationScope: 'current' },
    visible: false,
    view: { context: { isCurrent: () => true }, refreshPresentation: vi.fn() },
    dispose: vi.fn(),
  } as unknown as NativeWidgetPresentation;
  manager.entries.push(entry);
  const { result } = renderHook(() => useWidgetReferenceTabs('current', select, open));
  act(() => reveal({ ...entry, scope: 'other' }));
  expect(select).not.toHaveBeenCalled();
  act(() => reveal(entry));
  expect(select).toHaveBeenCalledWith(entry.id);
  expect(open).toHaveBeenCalledOnce();
  result.current.tabs[0].onClose?.();
  expect(unpin).toHaveBeenCalledWith(entry);
});
