// @vitest-environment jsdom
import { BrowserLinkTarget } from '@shared/browser/browserLinkOpening';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';
import { MessageBrowserEvent } from '@/features/browser/messageBrowserLinks';
import { configService } from '@/services/config';

import { MAX_BROWSER_TABS } from './displayTabIds';
import { useCoworkBrowserPanels } from './useCoworkBrowserPanels';

type Options = Parameters<typeof useCoworkBrowserPanels>[0];

vi.mock('@/features/browser/BrowserPanel', () => ({
  createBrowserPanelTab: (
    url = 'about:blank',
    options: { targetId?: string; profile?: string } = {},
  ) => ({
    ...options,
    id: options.targetId ?? 'user-tab',
    targetId: options.targetId ?? 'user-tab',
    url,
    title: '',
    profile: options.profile,
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([BrowserLinkTarget.Embedded, BrowserLinkTarget.Chrome])(
  'opens a local HTML preview in %s for the clicked conversation',
  async target => {
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...defaultConfig,
      browserHtmlLinkTarget: target,
    });
    const preview = {
      success: true,
      url: 'http://127.0.0.1:43210/preview/report.html',
      filePath: 'C:\\project\\report.html',
      rootPath: 'C:\\project',
      previewRootUrl: 'http://127.0.0.1:43210/preview/',
    };
    const createLocalHtmlPreview = vi.fn().mockResolvedValue(preview);
    const openInChrome = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        browser: {
          createLocalHtmlPreview,
          openInChrome,
          onAgentEnsureTab: () => vi.fn(),
          onAgentInteractionState: () => vi.fn(),
          onAgentFocusTab: () => vi.fn(),
          onAgentCloseTab: () => vi.fn(),
        },
      },
    });
    const openBrowserTab = vi.fn();
    const options: Options = {
      pendingBrowserTabsRef: { current: new Map() },
      displaySessionKey: 'clicked-session',
      currentSessionId: 'clicked-session',
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
      openBrowserTab,
    };
    const { rerender } = renderHook(current => useCoworkBrowserPanels(current), {
      initialProps: options,
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(MessageBrowserEvent.OpenLocalHtml, {
          detail: { filePath: 'report.html', workingDirectory: 'C:\\project' },
        }),
      );
      rerender({ ...options, displaySessionKey: 'another-session' });
    });
    expect(createLocalHtmlPreview).toHaveBeenCalledWith('report.html', 'C:\\project');
    if (target === BrowserLinkTarget.Chrome) {
      expect(openInChrome).toHaveBeenCalledWith(preview.url);
      expect(openBrowserTab).not.toHaveBeenCalled();
    } else {
      expect(openInChrome).not.toHaveBeenCalled();
      expect(openBrowserTab).toHaveBeenCalledWith(
        'clicked-session',
        expect.objectContaining({ url: preview.url, sourceFilePath: preview.filePath }),
        MAX_BROWSER_TABS,
      );
    }
  },
);

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

const localHtmlPreview = {
  success: true,
  url: 'http://127.0.0.1:43210/preview/report.html',
  filePath: 'C:\\project\\report.html',
  rootPath: 'C:\\project',
  previewRootUrl: 'http://127.0.0.1:43210/preview/',
};

function createMessageLinkOptions(mounted: boolean, accepted: boolean) {
  const options = createOptions();
  const openTab = vi.fn().mockReturnValue(accepted);
  if (mounted) {
    options.browserPanelRefs.current.set('session', {
      openTab,
      closeTab: vi.fn(),
      openTabContextMenu: vi.fn(),
      promoteRecordingSession: vi.fn(),
    });
  }
  const createLocalHtmlPreview = vi.fn().mockResolvedValue(localHtmlPreview);
  const openInChrome = vi.fn().mockResolvedValue({ success: true });
  Object.assign(window.electron.browser, { createLocalHtmlPreview, openInChrome });
  return { options, openTab, createLocalHtmlPreview, openInChrome };
}

test.each([
  { mounted: true, accepted: true },
  { mounted: false, accepted: true },
  { mounted: true, accepted: false },
])(
  'opens a message web link with mounted=$mounted and accepted=$accepted',
  ({ mounted, accepted }) => {
    const { options, openTab } = createMessageLinkOptions(mounted, accepted);
    renderHook(() => useCoworkBrowserPanels(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(MessageBrowserEvent.OpenWebUrl, {
          detail: { url: 'https://example.com/report.html?q=1#chart' },
        }),
      );
    });

    if (mounted) {
      expect(openTab).toHaveBeenCalledWith(
        'https://example.com/report.html?q=1#chart',
        expect.objectContaining({ targetId: 'user-tab' }),
      );
    } else {
      expect(openTab).not.toHaveBeenCalled();
    }
    if (mounted && !accepted) {
      expect(options.openBrowserTab).not.toHaveBeenCalled();
    } else {
      expect(options.openBrowserTab).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          targetId: 'user-tab',
          url: 'https://example.com/report.html?q=1#chart',
        }),
        MAX_BROWSER_TABS,
      );
    }
  },
);

test.each([
  { mounted: true, accepted: true },
  { mounted: false, accepted: true },
  { mounted: true, accepted: false },
])(
  'opens an HTML link in its original session with mounted=$mounted and accepted=$accepted',
  async ({ mounted, accepted }) => {
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...defaultConfig,
      browserHtmlLinkTarget: BrowserLinkTarget.Embedded,
    });
    const { options, openTab, createLocalHtmlPreview, openInChrome } = createMessageLinkOptions(
      mounted,
      accepted,
    );
    let finishPreview!: (value: typeof localHtmlPreview) => void;
    createLocalHtmlPreview.mockReturnValue(
      new Promise(resolve => {
        finishPreview = resolve;
      }),
    );
    const otherOpenTab = vi.fn().mockReturnValue(true);
    options.browserPanelRefs.current.set('other-session', {
      openTab: otherOpenTab,
      closeTab: vi.fn(),
      openTabContextMenu: vi.fn(),
      promoteRecordingSession: vi.fn(),
    });
    const { rerender } = renderHook(useCoworkBrowserPanels, { initialProps: options });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(MessageBrowserEvent.OpenLocalHtml, {
          detail: { filePath: 'report.html', workingDirectory: 'C:\\project' },
        }),
      );
    });
    rerender({ ...options, displaySessionKey: 'other-session', currentSessionId: 'other-session' });
    await act(async () => finishPreview(localHtmlPreview));

    expect(createLocalHtmlPreview).toHaveBeenCalledWith('report.html', 'C:\\project');
    expect(otherOpenTab).not.toHaveBeenCalled();
    expect(openInChrome).not.toHaveBeenCalled();
    const source = {
      targetId: 'user-tab',
      sourceFilePath: localHtmlPreview.filePath,
      sourcePreviewUrl: localHtmlPreview.url,
      sourceRootPath: localHtmlPreview.rootPath,
      sourcePreviewRootUrl: localHtmlPreview.previewRootUrl,
    };
    if (mounted) {
      expect(openTab).toHaveBeenCalledWith(localHtmlPreview.url, source);
    } else {
      expect(openTab).not.toHaveBeenCalled();
    }
    if (mounted && !accepted) {
      expect(options.openBrowserTab).not.toHaveBeenCalled();
    } else {
      expect(options.openBrowserTab).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ ...source, url: localHtmlPreview.url }),
        MAX_BROWSER_TABS,
      );
    }
  },
);

test.each(
  [BrowserLinkTarget.Embedded, BrowserLinkTarget.Chrome].flatMap(target =>
    ['#chart', '?view=compact&next=//example.com#chart'].map(navigationSuffix => ({
      target,
      navigationSuffix,
    })),
  ),
)(
  'preserves HTML navigation $navigationSuffix in $target',
  async ({ target, navigationSuffix }) => {
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...defaultConfig,
      browserHtmlLinkTarget: target,
    });
    const { options, openTab, openInChrome } = createMessageLinkOptions(true, true);
    renderHook(() => useCoworkBrowserPanels(options));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(MessageBrowserEvent.OpenLocalHtml, {
          detail: {
            filePath: 'report.html',
            navigationSuffix,
          },
        }),
      );
    });

    const url = `${localHtmlPreview.url}${navigationSuffix}`;
    if (target === BrowserLinkTarget.Chrome) {
      expect(openInChrome).toHaveBeenCalledWith(url);
      expect(openTab).not.toHaveBeenCalled();
      expect(options.openBrowserTab).not.toHaveBeenCalled();
    } else {
      expect(openInChrome).not.toHaveBeenCalled();
      expect(openTab).toHaveBeenCalledWith(url, expect.objectContaining({ sourcePreviewUrl: url }));
      expect(options.openBrowserTab).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({ url, sourcePreviewUrl: url }),
        MAX_BROWSER_TABS,
      );
    }
  },
);

test.each(['https://example.com', '//example.com', '?value=bad\n', '#bad\u0000', 1])(
  'rejects invalid HTML navigation suffix %s',
  async navigationSuffix => {
    const { options, openTab, createLocalHtmlPreview, openInChrome } = createMessageLinkOptions(
      true,
      true,
    );
    renderHook(() => useCoworkBrowserPanels(options));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(MessageBrowserEvent.OpenLocalHtml, {
          detail: { filePath: 'report.html', navigationSuffix },
        }),
      );
    });
    expect(createLocalHtmlPreview).not.toHaveBeenCalled();
    expect(openInChrome).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
    expect(options.openBrowserTab).not.toHaveBeenCalled();
  },
);

test('reopens the sidebar at tab capacity without creating another tab', () => {
  const options = createOptions({
    browserTabs: Array.from({ length: MAX_BROWSER_TABS }, (_, index) => ({
      id: String(index),
      targetId: String(index),
      url: 'about:blank',
      title: '',
      profile: 'embedded',
    })),
    hasDisplayTabs: true,
  });
  const { result } = renderHook(() => useCoworkBrowserPanels(options));
  act(() => result.current.handleCreateBrowserTab());
  expect(options.setIsDisplayPanelOpen).toHaveBeenCalledWith(true);
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);
  expect(options.setBrowserTabCreationSequence).not.toHaveBeenCalled();
});

test('closes the sidebar when its last tab disappears without creating a replacement', () => {
  const options = createOptions({ isDisplayPanelOpen: true, hasDisplayTabs: true });
  const { rerender } = renderHook(props => useCoworkBrowserPanels(props), {
    initialProps: options,
  });
  rerender({ ...options, hasDisplayTabs: false });
  expect(options.setIsDisplayPanelOpen).toHaveBeenCalledWith(false);
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);
  expect(options.setBrowserTabCreationSequence).not.toHaveBeenCalled();
});

test('does not treat switching to an empty session as closing the last tab', () => {
  const options = createOptions({ isDisplayPanelOpen: true, hasDisplayTabs: true });
  const { rerender } = renderHook(props => useCoworkBrowserPanels(props), {
    initialProps: options,
  });
  rerender({
    ...options,
    displaySessionKey: 'other',
    currentSessionId: 'other',
    hasDisplayTabs: false,
  });
  expect(options.setIsDisplayPanelOpen).not.toHaveBeenCalledWith(false);
  expect(options.pendingBrowserTabsRef.current.get('other')).toEqual([{}]);
});

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

test('allows reopening the sidebar after its last tool is closed', () => {
  const options = createOptions({ isDisplayPanelOpen: true, hasDisplayTabs: true });
  const { rerender } = renderHook(useCoworkBrowserPanels, { initialProps: options });
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);

  rerender({ ...options, hasDisplayTabs: false });
  expect(options.setIsDisplayPanelOpen).toHaveBeenCalledWith(false);
  expect(options.pendingBrowserTabsRef.current.size).toBe(0);
  rerender({ ...options, hasDisplayTabs: false, isDisplayPanelOpen: false });
  rerender({ ...options, hasDisplayTabs: false, isDisplayPanelOpen: true });

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

  expect(openTab).toHaveBeenCalledTimes(1);
  expect(options.setIsDisplayPanelOpen).toHaveBeenCalledWith(false);
});
