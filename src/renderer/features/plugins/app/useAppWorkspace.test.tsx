// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSessionSummaryVisibility } from '@/features/cowork/components/display/summary/useSessionSummaryVisibility';

import type { AppView } from './browserRegistry';

interface WorkspaceRequest {
  pluginId: string;
  epoch: string;
  contributionId: string;
  sessionId: string;
  selection?: unknown;
}

const fixture = vi.hoisted(() => ({
  views: [] as AppView[],
  requests: [] as WorkspaceRequest[],
  summaries: new Set<string>(),
  listeners: new Set<() => void>(),
}));
vi.mock('./runtime', () => ({
  appBrowserRegistry: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getViews: () => fixture.views,
    getWorkspaceRequests: () => fixture.requests,
    acknowledgeWorkspaceRequest: (request: WorkspaceRequest) => {
      fixture.requests = fixture.requests.filter(item => item !== request);
      fixture.listeners.forEach(listener => listener());
    },
    sessionPresentation: (sessionId: string) => ({
      summaryAvailable: fixture.summaries.has(sessionId),
    }),
  },
}));
import { useAppWorkspace } from './useAppWorkspace';

afterEach(() => {
  cleanup();
  fixture.summaries.clear();
  fixture.views = [];
  fixture.requests = [];
});
test('opens the exact source workspace request once and respects explicit tab closure', () => {
  const registered: AppView = {
    pluginId: 'fixture',
    epoch: 'first',
    id: 'team',
    slot: 'workspace.tab',
    labelKey: 'team',
    component: () => null,
  };
  fixture.views = [registered];
  const onOpen = vi.fn();
  const hook = renderHook(() => useAppWorkspace('source', onOpen));
  act(() => {
    fixture.requests = [
      {
        pluginId: 'fixture',
        epoch: 'first',
        contributionId: 'team',
        sessionId: 'source',
        selection: { key: 'group:room' },
      },
    ];
    fixture.listeners.forEach(listener => listener());
  });
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('app:fixture:team');
  expect(hook.result.current.views).toEqual([
    expect.objectContaining({
      tabId: 'app:fixture:team',
      selection: { key: 'group:room' },
      selectionRevision: 1,
    }),
  ]);
  expect(fixture.requests).toEqual([]);
  act(() => hook.result.current.open(registered));
  expect(hook.result.current.views[0]).toMatchObject({
    selection: undefined,
    selectionRevision: 2,
  });
  expect(onOpen).toHaveBeenCalledTimes(2);
  act(() => hook.result.current.close('app:fixture:team'));
  act(() => fixture.listeners.forEach(listener => listener()));
  expect(hook.result.current.views).toEqual([]);
  expect(onOpen).toHaveBeenCalledTimes(2);
  act(() => {
    fixture.views = [{ ...registered, epoch: 'second' }];
    fixture.requests = [
      {
        pluginId: 'fixture',
        epoch: 'first',
        contributionId: 'team',
        sessionId: 'source',
      },
      {
        pluginId: 'fixture',
        epoch: 'second',
        contributionId: 'team',
        sessionId: 'other',
      },
    ];
    fixture.listeners.forEach(listener => listener());
  });
  expect(hook.result.current.views).toEqual([]);
  expect(onOpen).toHaveBeenCalledTimes(2);
});
test('reveals a discovered plugin summary without an open tab and never rearms a dismissed chat', () => {
  const view = renderHook(
    ({ sessionId }) => {
      const workspace = useAppWorkspace(sessionId, () => undefined);
      const summary = useSessionSummaryVisibility(sessionId, workspace.hasSummary);
      return { workspace, summary };
    },
    { initialProps: { sessionId: 'source' } },
  );
  expect(view.result.current.summary.visible).toBe(false);
  act(() => {
    fixture.summaries.add('source');
    fixture.listeners.forEach(listener => listener());
  });
  expect(view.result.current.workspace.views).toEqual([]);
  expect(view.result.current.summary.visible).toBe(true);
  act(() => view.result.current.summary.close());
  act(() => {
    fixture.summaries.clear();
    fixture.listeners.forEach(listener => listener());
  });
  expect(view.result.current.workspace.hasSummary).toBe(false);
  act(() => {
    fixture.summaries.add('source');
    fixture.listeners.forEach(listener => listener());
  });
  expect(view.result.current.summary.visible).toBe(false);
  view.rerender({ sessionId: 'other' });
  expect(view.result.current.workspace.hasSummary).toBe(false);
  expect(view.result.current.summary.visible).toBe(false);
});
