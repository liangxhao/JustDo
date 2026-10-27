// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  getWebpageEmbedPresentations,
  type WebpageEmbedPresentation,
} from '@/libs/openclaw-chat/components/webpage-embed/presentations';

import { useWebpageEmbedTabs } from './useWebpageEmbedTabs';

beforeEach(() => {
  vi.spyOn(getWebpageEmbedPresentations(), 'requestLayout').mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 10));
  vi.restoreAllMocks();
});

test('retains the active scope until leaving a deleted conversation', () => {
  const manager = getWebpageEmbedPresentations();
  const dispose = vi.fn();
  manager.entries.push({
    id: 'webpage-one',
    scope: 'current',
    pinned: true,
    returnPending: false,
    anchors: new Set(),
    layer: document.createElement('div'),
    context: { presentationScope: 'current' },
    preview: { title: 'Report' },
    visible: false,
    view: { context: { isCurrent: () => true }, refreshPresentation: vi.fn() },
    dispose,
  } as unknown as WebpageEmbedPresentation);
  const { result, rerender } = renderHook(
    ({ scope, ids }) => useWebpageEmbedTabs(scope, vi.fn(), vi.fn(), ids),
    { initialProps: { scope: 'current', ids: ['older'] } },
  );
  expect(result.current.tabs.map(tab => tab.id)).toEqual(['webpage-one']);
  expect(result.current.tabs[0].reference).toBe(true);
  expect(result.current.hasRetainedPanels).toBe(true);
  rerender({ scope: 'current', ids: [] });
  expect(dispose).not.toHaveBeenCalled();
  rerender({ scope: 'another', ids: ['another'] });
  expect(result.current.tabs).toHaveLength(0);
  expect(dispose).toHaveBeenCalledOnce();
});

test('reveals only the current conversation and closes through unpin', () => {
  const manager = getWebpageEmbedPresentations();
  let reveal: (entry: WebpageEmbedPresentation) => void = () => undefined;
  vi.spyOn(manager, 'onReveal').mockImplementation(listener => {
    reveal = listener;
    return () => undefined;
  });
  const unpin = vi.spyOn(manager, 'unpin').mockImplementation(() => undefined);
  const select = vi.fn();
  const open = vi.fn();
  const entry = {
    id: 'webpage-one',
    scope: 'current',
    pinned: true,
    preview: { title: 'Report' },
    anchors: new Set(),
    layer: document.createElement('div'),
    context: { presentationScope: 'current' },
    visible: false,
    view: { context: { isCurrent: () => true }, refreshPresentation: vi.fn() },
    dispose: vi.fn(),
  } as unknown as WebpageEmbedPresentation;
  manager.entries.push(entry);
  const { result } = renderHook(() => useWebpageEmbedTabs('current', select, open));
  act(() => reveal({ ...entry, scope: 'other' }));
  expect(select).not.toHaveBeenCalled();
  act(() => reveal(entry));
  expect(select).toHaveBeenCalledWith(entry.id);
  expect(open).toHaveBeenCalledOnce();
  result.current.tabs[0].onClose?.();
  expect(unpin).toHaveBeenCalledWith(entry);
});
