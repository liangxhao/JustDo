// @vitest-environment jsdom
import { SessionCopyErrorCode } from '@shared/cowork/sessionCopy';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AppSessionPresentation } from '../../../../../../plugins/sdk/app-plugin-sdk/browser';

const fixture = vi.hoisted(() => ({
  presentation: {} as AppSessionPresentation,
  revision: 0,
  listeners: new Set<() => void>(),
  copy: vi.fn(),
}));
vi.mock('@/features/plugins/app/runtime', () => ({
  appBrowserRegistry: {
    sessionPresentation: () => fixture.presentation,
    getContextRevision: () => fixture.revision,
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
  },
}));
vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: { copySession: fixture.copy },
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

import { useCoworkSessionActions } from './useCoworkSessionActions';

type Options = Parameters<typeof useCoworkSessionActions>[0];

function options(action: 'copy' | 'export') {
  const snapshot = vi.fn().mockReturnValue(null);
  const props: Options = {
    setPendingSessionListAction: vi.fn(),
    pendingSessionListAction: { action, sessionId: 'source' },
    currentSession: {
      id: 'source',
      title: 'Source',
      status: 'idle',
      pinned: false,
      cwd: '',
      agentId: 'main',
      executionMode: 'local',
      permissionMode: 'ask',
      activeSkillIds: [],
      createdAt: 1,
      updatedAt: 1,
    },
    setPreferredDisplayTabId: vi.fn(),
    setIsDisplayPanelOpen: vi.fn(),
    setIsWorkspaceFilesOpen: vi.fn(),
    currentSessionRuntimeRunning: false,
    sessions: [],
    sessionTranscriptMutationRef: { current: null },
    setSessionTranscriptMutation: vi.fn(),
    currentSessionIdRef: { current: 'source' },
    chatWrapperRef: {
      current: { getExportSnapshot: snapshot },
    } as unknown as Options['chatWrapperRef'],
    currentGatewaySessionKey: 'native-source',
    setSessionExportMessageCount: vi.fn(),
    setIsSessionExportOpen: vi.fn(),
    sessionTranscriptMutation: null,
  };
  return { props, snapshot };
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.presentation = {};
  fixture.revision = 0;
  fixture.copy.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('rechecks current plugin copy restrictions after selecting an idle source', () => {
  fixture.presentation = { copyAllowed: false };
  const { props } = options('copy');
  renderHook(() => useCoworkSessionActions(props));
  expect(fixture.copy).not.toHaveBeenCalled();
  expect(props.setPendingSessionListAction).toHaveBeenCalledWith(null);
  expect(props.sessionTranscriptMutationRef.current).toBeNull();
});

it.each([
  [SessionCopyErrorCode.RuntimeUnknown, 'coworkCopyRuntimeUnknown'],
  [SessionCopyErrorCode.CreationUnconfirmed, 'coworkCopyCreationUnconfirmed'],
])('shows the specific copy failure for %s and releases the action', async (code, message) => {
  fixture.copy.mockImplementation(async (_session, onFailure) => {
    onFailure(code);
    return null;
  });
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const { props } = options('copy');
  await act(async () => {
    renderHook(() => useCoworkSessionActions(props));
  });
  const toast = dispatch.mock.calls.map(([event]) => event as CustomEvent)
    .find(event => event.type === 'app:showToast');
  expect(toast?.detail).toBe(message);
  expect(props.sessionTranscriptMutationRef.current).toBeNull();
  expect(fixture.copy).toHaveBeenCalledOnce();
  dispatch.mockRestore();
});

it('withdraws a waiting export when related plugin activity changes without changing source execution', () => {
  const { props, snapshot } = options('export');
  renderHook(() => useCoworkSessionActions(props));
  expect(props.setIsSessionExportOpen).not.toHaveBeenCalled();
  act(() => {
    fixture.presentation = { status: 'running' };
    fixture.revision++;
    fixture.listeners.forEach(listener => listener());
  });
  snapshot.mockReturnValue({ sessionKey: 'native-source', isLoading: false, messages: ['one'] });
  act(() => vi.advanceTimersByTime(1000));
  expect(props.currentSessionRuntimeRunning).toBe(false);
  expect(props.setPendingSessionListAction).toHaveBeenCalledWith(null);
  expect(props.setIsSessionExportOpen).not.toHaveBeenCalled();
});

it('rechecks export permission at snapshot polling even before a presentation notification', () => {
  const { props, snapshot } = options('export');
  renderHook(() => useCoworkSessionActions(props));
  fixture.presentation = { exportAllowed: false };
  snapshot.mockReturnValue({ sessionKey: 'native-source', isLoading: false, messages: ['one'] });
  act(() => vi.advanceTimersByTime(100));
  expect(props.setPendingSessionListAction).toHaveBeenCalledWith(null);
  expect(props.setIsSessionExportOpen).not.toHaveBeenCalled();
});

it('continues to open ordinary export only for a ready snapshot of the current native source', () => {
  const { props, snapshot } = options('export');
  snapshot.mockReturnValue({
    sessionKey: 'another-native-source',
    isLoading: false,
    messages: ['one'],
  });
  renderHook(() => useCoworkSessionActions(props));
  expect(props.setIsSessionExportOpen).not.toHaveBeenCalled();
  snapshot.mockReturnValue({
    sessionKey: 'native-source',
    isLoading: false,
    messages: ['one', 'two'],
  });
  act(() => vi.advanceTimersByTime(100));
  expect(props.setSessionExportMessageCount).toHaveBeenCalledWith(2);
  expect(props.setIsSessionExportOpen).toHaveBeenCalledWith(true);
});
