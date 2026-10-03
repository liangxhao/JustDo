// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { useCoworkBrowserPanels } from './useCoworkBrowserPanels';

type Options = Parameters<typeof useCoworkBrowserPanels>[0];

vi.mock('@/features/browser/BrowserPanel', () => ({
  createBrowserPanelTab: (url = 'about:blank', options: { targetId: string; profile: string }) => ({
    id: options.targetId,
    targetId: options.targetId,
    url,
    title: '',
    profile: options.profile,
  }),
}));

afterEach(cleanup);

test.each([
  { mounted: true, accepted: true },
  { mounted: false, accepted: true },
  { mounted: true, accepted: false },
])('handles an agent tab with mounted=$mounted and accepted=$accepted', ({ mounted, accepted }) => {
  type Options = Parameters<typeof useCoworkBrowserPanels>[0];
  type Ensure = Parameters<Window['electron']['browser']['onAgentEnsureTab']>[0];
  let ensure!: Ensure;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      browser: {
        onAgentEnsureTab: (callback: Ensure) => {
          ensure = callback;
          return vi.fn();
        },
        onAgentInteractionState: () => vi.fn(),
        onAgentFocusTab: () => vi.fn(),
        onAgentCloseTab: () => vi.fn(),
      },
    },
  });
  const openTab = vi.fn().mockReturnValue(accepted);
  const setSessionField = vi.fn();
  const options: Options = {
    pendingBrowserTabsRef: { current: new Map() },
    displaySessionKey: 'session',
    currentSessionId: 'session',
    browserTabs: [],
    isDisplayPanelOpen: false,
    hasDisplayTabs: false,
    setIsWorkspaceFilesOpen: vi.fn(),
    setIsDisplayPanelOpen: vi.fn(),
    setHasBrowserPanelOpened: vi.fn(),
    setIsBrowserPanelOpen: vi.fn(),
    setBrowserTabCreationSequence: vi.fn(),
    browserTabCreationSequence: 0,
    browserPanelRefs: {
      current: new Map(
        mounted
          ? [
              [
                'session',
                {
                  openTab,
                  closeTab: vi.fn(),
                  openTabContextMenu: vi.fn(),
                  promoteRecordingSession: vi.fn(),
                },
              ],
            ]
          : [],
      ),
    },
    displayStates: {},
    setBrowserAgentPanelStates: vi.fn(),
    setSessionField,
    pendingBrowserAgentPanelStatesRef: { current: new Map() },
    sessions: [],
    availableAgentBrowserSessionIdsRef: { current: ['session'] },
    handleBrowserTargetChange: vi.fn(),
    openBrowserTab: vi.fn(),
  };
  renderHook(() => useCoworkBrowserPanels(options));
  act(() => ensure({ sessionId: 'session', targetId: 'requested', profile: 'embedded' }));
  if (mounted)
    expect(openTab).toHaveBeenCalledWith('about:blank', {
      targetId: 'requested',
      profile: 'embedded',
      customTitle: undefined,
    });
  else expect(openTab).not.toHaveBeenCalled();
  if (mounted && !accepted) {
    expect(setSessionField).not.toHaveBeenCalled();
    expect(options.setIsDisplayPanelOpen).not.toHaveBeenCalled();
    return;
  }
  const update = setSessionField.mock.calls.find(call => call[1] === 'browserTabs')![2];
  expect(update([])).toEqual([expect.objectContaining({ targetId: 'requested' })]);
  expect(setSessionField).toHaveBeenCalledWith('session', 'hasBrowserPanelOpened', true);
  openTab.mockClear();
  act(() => ensure({ sessionId: 'other-session', targetId: 'foreign', profile: 'embedded' }));
  expect(openTab).not.toHaveBeenCalled();
});

function createOptions(overrides: Partial<Options> = {}): Options {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      browser: {
        onAgentEnsureTab: () => vi.fn(),
        onAgentInteractionState: () => vi.fn(),
        onAgentFocusTab: () => vi.fn(),
        onAgentCloseTab: () => vi.fn(),
      },
    },
  });
  return {
    pendingBrowserTabsRef: { current: new Map() },
    displaySessionKey: 'session',
    currentSessionId: 'session',
    browserTabs: [],
    isDisplayPanelOpen: false,
    hasDisplayTabs: false,
    setIsWorkspaceFilesOpen: vi.fn(),
    setIsDisplayPanelOpen: vi.fn(),
    setHasBrowserPanelOpened: vi.fn(),
    setIsBrowserPanelOpen: vi.fn(),
    setBrowserTabCreationSequence: vi.fn(),
    browserTabCreationSequence: 0,
    browserPanelRefs: { current: new Map() },
    displayStates: {},
    setBrowserAgentPanelStates: vi.fn(),
    setSessionField: vi.fn(),
    pendingBrowserAgentPanelStatesRef: { current: new Map() },
    sessions: [],
    availableAgentBrowserSessionIdsRef: { current: [] },
    handleBrowserTargetChange: vi.fn(),
    openBrowserTab: vi.fn(),
    ...overrides,
  };
}

test.each(['session', null])(
  'creates one initial new-tab page when opening an empty %s sidebar',
  sessionId => {
    const options = createOptions({
      currentSessionId: sessionId,
      displaySessionKey: sessionId ?? '__home__',
    });
    const { rerender } = renderHook(useCoworkBrowserPanels, { initialProps: options });
    expect(options.pendingBrowserTabsRef.current.size).toBe(0);

    rerender({ ...options, isDisplayPanelOpen: true });

    expect(options.pendingBrowserTabsRef.current.get(options.displaySessionKey)).toEqual([{}]);
    expect(options.setIsDisplayPanelOpen).toHaveBeenCalledWith(true);
    expect(options.setIsBrowserPanelOpen).toHaveBeenCalledWith(true);
    expect(options.setHasBrowserPanelOpened).toHaveBeenCalledWith(true);
    rerender({ ...options, isDisplayPanelOpen: true, displayStates: {} });
    expect(options.pendingBrowserTabsRef.current.get(options.displaySessionKey)).toEqual([{}]);
    expect(options.setBrowserTabCreationSequence).toHaveBeenCalledTimes(1);
  },
);

test('keeps existing tools selected and opens a new-tab page after the last tool is closed', () => {
  const options = createOptions({ isDisplayPanelOpen: true, hasDisplayTabs: true });
  const { rerender } = renderHook(useCoworkBrowserPanels, { initialProps: options });
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);

  rerender({ ...options, hasDisplayTabs: false });

  expect(options.pendingBrowserTabsRef.current.get('session')).toEqual([{}]);
});

test('reopens retained browser tabs without creating an extra page', () => {
  const options = createOptions({
    isDisplayPanelOpen: true,
    browserTabs: [
      { id: 'retained', targetId: 'retained', title: 'Page', url: 'https://example.com' },
    ],
  });
  renderHook(() => useCoworkBrowserPanels(options));

  expect(options.pendingBrowserTabsRef.current.size).toBe(0);
  expect(options.setIsBrowserPanelOpen).toHaveBeenCalledWith(true);
  expect(options.handleBrowserTargetChange).toHaveBeenCalledWith('retained');
});

test('queues another blank page on each creation and includes pending tabs in the capacity limit', () => {
  const options = createOptions({
    isDisplayPanelOpen: true,
    hasDisplayTabs: true,
    browserTabs: Array.from({ length: 6 }, (_, index) => ({
      id: `tab-${index}`,
      targetId: `tab-${index}`,
      title: '',
      url: 'about:blank',
    })),
  });
  const { result } = renderHook(() => useCoworkBrowserPanels(options));

  act(() => {
    result.current.handleCreateBrowserTab();
    result.current.handleCreateBrowserTab();
    result.current.handleCreateBrowserTab();
  });

  expect(options.pendingBrowserTabsRef.current.get('session')).toEqual([{}, {}]);
  expect(options.setBrowserTabCreationSequence).toHaveBeenCalledTimes(2);
});

test('waits for a temporary conversation to become available before creating its first tab', () => {
  const options = createOptions({ currentSessionId: 'temp-1', isDisplayPanelOpen: true });
  const { rerender } = renderHook(useCoworkBrowserPanels, { initialProps: options });
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);

  rerender({ ...options, currentSessionId: 'session' });

  expect(options.pendingBrowserTabsRef.current.get('session')).toEqual([{}]);
});

test('drains the initial page once when its browser panel becomes ready', () => {
  const options = createOptions({ isDisplayPanelOpen: true });
  const { rerender } = renderHook(useCoworkBrowserPanels, { initialProps: options });
  const openTab = vi.fn().mockReturnValue(true);
  options.browserPanelRefs.current.set('session', {
    openTab,
    closeTab: vi.fn(),
    openTabContextMenu: vi.fn(),
    promoteRecordingSession: vi.fn(),
  });

  rerender({ ...options, hasDisplayTabs: true, browserTabCreationSequence: 1 });
  rerender({ ...options, hasDisplayTabs: true, browserTabCreationSequence: 2 });

  expect(openTab).toHaveBeenCalledTimes(1);
  expect(openTab).toHaveBeenCalledWith(undefined, expect.any(Object));
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);
});

test('creates one initial page when StrictMode replays effects after the queue has drained', () => {
  const options = createOptions({ isDisplayPanelOpen: true });
  const openTab = vi.fn().mockReturnValue(true);
  options.browserPanelRefs.current.set('session', {
    openTab,
    closeTab: vi.fn(),
    openTabContextMenu: vi.fn(),
    promoteRecordingSession: vi.fn(),
  });
  const { rerender } = renderHook(useCoworkBrowserPanels, {
    initialProps: options,
    wrapper: ({ children }) => createElement(StrictMode, null, children),
  });

  expect(openTab).toHaveBeenCalledTimes(1);
  expect(options.setBrowserTabCreationSequence).toHaveBeenCalledTimes(1);
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);

  rerender({ ...options, hasDisplayTabs: true });
  rerender({ ...options, hasDisplayTabs: false, browserTabCreationSequence: 1 });

  expect(openTab).toHaveBeenCalledTimes(2);
});
