// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import {
  getMcpAppPresentations,
  type McpAppPresentation,
} from '@/libs/openclaw-chat/components/mcp-app/presentations';

import { useMcpAppReferenceTabs } from './useMcpAppReferenceTabs';

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('an inline background canvas retains its controller on Home without adding a pinned tab', () => {
  const manager = getMcpAppPresentations();
  const dispose = vi.fn();
  manager.entries.push({
    scope: 'drawing-chat',
    pinned: false,
    returnPending: false,
    anchors: new Set(),
    layer: document.createElement('div'),
    visible: false,
    view: { resume: vi.fn(), retainOnNavigation: true },
    dispose,
  } as unknown as McpAppPresentation);
  const { result, rerender } = renderHook(
    ({ ids }) => useMcpAppReferenceTabs('home', vi.fn(), vi.fn(), undefined, ids),
    { initialProps: { ids: ['drawing-chat'] } },
  );
  expect(result.current.hasRetainedPanels).toBe(true);
  expect(result.current.tabs).toEqual([]);
  expect(dispose).not.toHaveBeenCalled();
  rerender({ ids: [] });
  expect(result.current.hasRetainedPanels).toBe(false);
  expect(dispose).toHaveBeenCalledOnce();
});

test('a stale session list retains the active App and removes it after leaving the deleted scope', () => {
  const manager = getMcpAppPresentations();
  const dispose = vi.fn();
  manager.entries.push({
    scope: 'current',
    pinned: false,
    returnPending: true,
    anchors: new Set(),
    layer: document.createElement('div'),
    visible: false,
    view: { resume: vi.fn() },
    dispose,
  } as unknown as McpAppPresentation);
  const { rerender } = renderHook(
    ({ scope, ids }) => useMcpAppReferenceTabs(scope, vi.fn(), vi.fn(), undefined, ids),
    {
      initialProps: { scope: 'current', ids: ['older'] },
    },
  );
  expect(manager.entries).toHaveLength(1);
  expect(dispose).not.toHaveBeenCalled();
  rerender({ scope: 'current', ids: [] });
  expect(dispose).not.toHaveBeenCalled();
  rerender({ scope: 'another', ids: ['another'] });
  expect(manager.entries).toHaveLength(0);
  expect(dispose).toHaveBeenCalledOnce();
});
