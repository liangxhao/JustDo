// @vitest-environment jsdom

import { REVIEW_TAB_ID } from '@shared/cowork/sessionReview';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  createSessionDisplayState,
  enforceBackgroundTabLimit,
  HOME_DISPLAY_SESSION_KEY,
  useSessionDisplayState,
} from './useSessionDisplayState';

describe('useSessionDisplayState', () => {
  it('isolates review navigation by session and restores it when returning', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: 'session-a' } },
    );
    act(() => {
      result.current.setters.setIsReviewOpen(true);
      result.current.setters.setReviewFocusPath('src/main.ts');
      result.current.setters.setReviewFocusVersion(1);
      result.current.setters.setPreferredDisplayTabId(REVIEW_TAB_ID);
    });
    rerender({ sessionId: 'session-b' });
    expect(result.current.state.isReviewOpen).toBe(false);
    expect(result.current.state.reviewFocusPath).toBe('');
    rerender({ sessionId: 'session-a' });
    expect(result.current.state.isReviewOpen).toBe(true);
    expect(result.current.state.reviewFocusPath).toBe('src/main.ts');
    expect(result.current.state.reviewFocusVersion).toBe(1);
    expect(result.current.state.preferredDisplayTabId).toBe(REVIEW_TAB_ID);
  });

  it('evicts review tabs through the shared background limit and clears their selection', () => {
    const background = {
      ...createSessionDisplayState(520),
      isReviewOpen: true,
      preferredDisplayTabId: REVIEW_TAB_ID,
      tabRecency: { [REVIEW_TAB_ID]: 1 },
    };
    const active = { ...background, tabRecency: { [REVIEW_TAB_ID]: 2 } };
    const retained = enforceBackgroundTabLimit({ background, active }, 'active', 0);
    expect(retained.background.isReviewOpen).toBe(false);
    expect(retained.background.preferredDisplayTabId).toBeNull();
    expect(retained.background.tabRecency).toEqual({});
    expect(retained.active.isReviewOpen).toBe(true);
  });

  it('keeps only the most recently used background tabs while protecting the active session', () => {
    const sessionA = {
      ...createSessionDisplayState(520),
      terminalTabs: [
        { id: 'terminal:old', cwd: 'C:\\a', label: 'Old' },
        { id: 'terminal:recent', cwd: 'C:\\a', label: 'Recent' },
      ],
      filePreviews: [
        {
          filePath: 'C:\\a\\large.txt',
          content: 'large content',
          editToken: 'token',
          version: '1',
        },
      ],
      tabRecency: {
        'terminal:old': 1,
        'file:C:/a/large.txt': 2,
        'terminal:recent': 3,
      },
    };
    const activeSession = {
      ...createSessionDisplayState(520),
      terminalTabs: [
        { id: 'terminal:active-1', cwd: 'C:\\b', label: 'Active 1' },
        { id: 'terminal:active-2', cwd: 'C:\\b', label: 'Active 2' },
      ],
      tabRecency: { 'terminal:active-1': 4, 'terminal:active-2': 5 },
    };

    const retained = enforceBackgroundTabLimit(
      { 'session-a': sessionA, 'session-b': activeSession },
      'session-b',
      1,
    );

    expect(retained['session-a'].terminalTabs.map(tab => tab.id)).toEqual(['terminal:recent']);
    expect(retained['session-a'].filePreviews).toEqual([]);
    expect(retained['session-b'].terminalTabs).toHaveLength(2);
  });

  it('protects every display tab owned by a running background task', () => {
    const background = {
      ...createSessionDisplayState(520),
      browserTabs: [
        { id: 'embedded-1', targetId: 'embedded-1', title: 'Agent', url: 'https://example.com/' },
      ],
      terminalTabs: [{ id: 'terminal:old', cwd: 'C:\\a', label: 'Old' }],
      tabRecency: { 'browser:embedded-1': 1, 'terminal:old': 2 },
    };
    const active = createSessionDisplayState(520);

    const retained = enforceBackgroundTabLimit({ background, active }, 'active', 0, ['background']);

    expect(retained.background.browserTabs).toEqual(background.browserTabs);
    expect(retained.background.terminalTabs).toEqual(background.terminalTabs);
  });

  it('evicts idle embedded browser tabs using the same bounded background policy', () => {
    const background = {
      ...createSessionDisplayState(520),
      browserTabs: [
        { id: 'embedded-1', targetId: 'embedded-1', title: 'Agent', url: 'https://example.com/' },
      ],
      tabRecency: { 'browser:embedded-1': 1 },
    };
    const active = createSessionDisplayState(520);

    const retained = enforceBackgroundTabLimit({ background, active }, 'active', 0);

    expect(retained.background.browserTabs).toEqual([]);
    expect(retained.background.browserPanelTargetId).toBeNull();
  });

  it('retains an unsent recording runtime even with zero background tabs, then releases protection', () => {
    const background = {
      ...createSessionDisplayState(520),
      hasBrowserPanelOpened: true,
      hasBrowserRecording: true,
      browserTabs: [
        { id: 'recording', targetId: 'recording', title: 'Recording', url: 'https://example.com/' },
      ],
    };
    const states = { background, active: createSessionDisplayState(520) };
    const retained = enforceBackgroundTabLimit(states, 'active', 0);
    expect(retained.background.browserTabs).toHaveLength(1);
    expect(retained.background.hasBrowserPanelOpened).toBe(true);
    const released = enforceBackgroundTabLimit(
      { ...retained, background: { ...retained.background, hasBrowserRecording: false } },
      'active',
      0,
    );
    expect(released.background.browserTabs).toHaveLength(0);
    expect(released.background.hasBrowserPanelOpened).toBe(false);
  });

  it('keeps tabs and panel visibility isolated by session', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: 'session-a' } },
    );

    act(() => {
      result.current.setters.setTerminalTabs([
        { id: 'terminal:a', cwd: 'C:\\workspace-a', label: 'Terminal 1' },
      ]);
      result.current.setters.setIsDisplayPanelOpen(true);
      result.current.setters.setPreferredDisplayTabId('terminal:a');
    });
    const sessionASetters = result.current.setters;

    rerender({ sessionId: 'session-b' });
    expect(result.current.state.terminalTabs).toEqual([]);
    expect(result.current.state.isDisplayPanelOpen).toBe(false);

    act(() => {
      result.current.setters.setIsDisplayPanelOpen(true);
      sessionASetters.setTerminalTabs(current => [
        ...current,
        { id: 'terminal:a2', cwd: 'C:\\workspace-a', label: 'Terminal 2' },
      ]);
    });
    expect(result.current.state.terminalTabs).toEqual([]);
    rerender({ sessionId: 'session-a' });
    expect(result.current.state.terminalTabs).toHaveLength(2);
    expect(result.current.state.preferredDisplayTabId).toBe('terminal:a');
    expect(result.current.state.isDisplayPanelOpen).toBe(true);
  });

  it('keeps a separate state for the new-conversation home', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: null as string | null } },
    );

    act(() => result.current.setters.setIsWorkspaceFilesOpen(true));
    rerender({ sessionId: 'session-a' });
    expect(result.current.state.isWorkspaceFilesOpen).toBe(false);

    rerender({ sessionId: null });
    expect(result.current.sessionKey).toBe(HOME_DISPLAY_SESSION_KEY);
    expect(result.current.state.isWorkspaceFilesOpen).toBe(true);
  });

  it('restores file preview tabs after switching away from a session', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: 'session-a' } },
    );
    const preview = {
      filePath: 'C:\\workspace-a\\notes.md',
      content: '# Notes',
      editToken: 'edit-token',
      version: '1',
    };

    act(() => {
      result.current.setters.setFilePreviews([preview]);
      result.current.setters.setPreferredDisplayTabId('file:C:/workspace-a/notes.md');
      result.current.setters.setIsDisplayPanelOpen(true);
    });

    rerender({ sessionId: 'session-b' });
    expect(result.current.state.filePreviews).toEqual([]);

    rerender({ sessionId: 'session-a' });
    expect(result.current.state.filePreviews).toEqual([preview]);
    expect(result.current.state.preferredDisplayTabId).toBe('file:C:/workspace-a/notes.md');
    expect(result.current.state.isDisplayPanelOpen).toBe(true);
  });

  it('restores image tabs and their selection after switching sessions', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: 'session-a' } },
    );
    const preview = {
      kind: 'image' as const,
      filePath: 'C:/workspace/a.png',
      src: 'localfile:///C%3A/workspace/a.png',
      label: 'a.png',
    };
    act(() => {
      result.current.setters.setFilePreviews([preview]);
      result.current.setters.setPreferredDisplayTabId('file:C:/workspace/a.png');
      result.current.setters.setIsDisplayPanelOpen(true);
    });
    rerender({ sessionId: 'session-b' });
    expect(result.current.state.filePreviews).toEqual([]);
    rerender({ sessionId: 'session-a' });
    expect(result.current.state.filePreviews).toEqual([preview]);
    expect(result.current.state.preferredDisplayTabId).toBe('file:C:/workspace/a.png');
  });

  it('restores the resized display panel width after switching sessions', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: 'session-a' } },
    );

    act(() => result.current.setters.setBrowserPanelWidth(680));
    rerender({ sessionId: 'session-b' });
    expect(result.current.state.browserPanelWidth).toBe(520);

    act(() => result.current.setters.setBrowserPanelWidth(440));
    rerender({ sessionId: 'session-a' });
    expect(result.current.state.browserPanelWidth).toBe(680);

    rerender({ sessionId: 'session-b' });
    expect(result.current.state.browserPanelWidth).toBe(440);
  });

  it('updates retained background runtime state without activating the session', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: 'session-a' } },
    );

    act(() => {
      result.current.setters.setTerminalTabs([
        { id: 'terminal:a', cwd: 'C:\\workspace-a', label: 'Terminal 1' },
      ]);
    });
    rerender({ sessionId: 'session-b' });

    act(() => {
      result.current.setSessionField('session-a', 'browserPanelTargetId', 'page-a');
    });

    expect(result.current.sessionKey).toBe('session-b');
    expect(result.current.state.browserPanelTargetId).toBeNull();
    expect(result.current.states['session-a'].browserPanelTargetId).toBe('page-a');
    expect(result.current.states['session-a'].terminalTabs).toHaveLength(1);
  });

  it('applies concurrent functional browser-tab updates without dropping either tab', () => {
    const { result } = renderHook(() => useSessionDisplayState('session-a', 520));
    const first = {
      id: 'embedded-1',
      targetId: 'embedded-1',
      title: 'First',
      url: 'https://first.example/',
    };
    const second = {
      id: 'embedded-2',
      targetId: 'embedded-2',
      title: 'Second',
      url: 'https://second.example/',
    };

    act(() => {
      result.current.setSessionField('session-a', 'browserTabs', current => [...current, first]);
      result.current.setSessionField('session-a', 'browserTabs', current => [...current, second]);
    });

    expect(result.current.state.browserTabs.map(tab => tab.targetId)).toEqual([
      'embedded-1',
      'embedded-2',
    ]);
  });

  it('opens the first browser tab atomically with the display panel', () => {
    const { result } = renderHook(() => useSessionDisplayState('session-a', 520));
    const tab = {
      id: 'embedded-local-html',
      targetId: 'embedded-local-html',
      title: '',
      url: 'http://127.0.0.1:43128/token/index.html',
      sourceFilePath: 'C:\\workspace\\site\\index.html',
      sourcePreviewUrl: 'http://127.0.0.1:43128/token/index.html',
      sourceRootPath: 'C:\\workspace\\site',
      sourcePreviewRootUrl: 'http://127.0.0.1:43128/token/',
    };

    act(() => result.current.openBrowserTab('session-a', tab, 8));

    expect(result.current.state.browserTabs).toEqual([tab]);
    expect(result.current.state.browserPanelTargetId).toBe(tab.targetId);
    expect(result.current.state.preferredDisplayTabId).toBe(`browser:${tab.targetId}`);
    expect(result.current.state.isDisplayPanelOpen).toBe(true);
    expect(result.current.state.isBrowserPanelOpen).toBe(true);
    expect(result.current.state.hasBrowserPanelOpened).toBe(true);
    expect(result.current.state.isWorkspaceFilesOpen).toBe(false);
  });

  it('moves home state through temporary-session promotion', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionDisplayState(sessionId, 520),
      { initialProps: { sessionId: null as string | null } },
    );

    act(() => {
      result.current.setters.setIsDisplayPanelOpen(true);
      result.current.setters.setUnsupportedFilePreviews(['C:\\workspace\\notes.txt']);
      result.current.promote(HOME_DISPLAY_SESSION_KEY, 'temp-1');
    });
    rerender({ sessionId: 'temp-1' });
    const runtimeId = result.current.state.runtimeId;
    expect(result.current.state.isDisplayPanelOpen).toBe(true);
    expect(result.current.state.unsupportedFilePreviews).toEqual(['C:\\workspace\\notes.txt']);

    act(() => result.current.promote('temp-1', 'session-a'));
    rerender({ sessionId: 'session-a' });
    expect(result.current.state.runtimeId).toBe(runtimeId);
    expect(result.current.state.isDisplayPanelOpen).toBe(true);
    expect(result.current.state.unsupportedFilePreviews).toEqual(['C:\\workspace\\notes.txt']);

    rerender({ sessionId: null });
    expect(result.current.state.isDisplayPanelOpen).toBe(false);
  });
});
