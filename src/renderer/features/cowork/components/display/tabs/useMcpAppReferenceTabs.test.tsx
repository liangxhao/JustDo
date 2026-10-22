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

test('a stale session list retains the active App and removes it after leaving the deleted scope', () => {
  const manager = getMcpAppPresentations();
  const dispose = vi.fn();
  manager.entries.push({
    scope: 'current',
    pinned: false,
    returnPending: true,
    anchors: new Set(),
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
