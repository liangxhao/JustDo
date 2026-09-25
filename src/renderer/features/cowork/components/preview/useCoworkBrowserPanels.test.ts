// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useCoworkBrowserPanels } from './useCoworkBrowserPanels';

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
