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

function options() {
  const props: Options = {
    setPendingSessionListAction: vi.fn(),
    pendingSessionListAction: { action: 'copy', sessionId: 'source' },
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
    currentSessionRuntimeRunning: false,
    sessionTranscriptMutationRef: { current: null },
    setSessionTranscriptMutation: vi.fn(),
    sessionTranscriptMutation: null,
  };
  return props;
}

beforeEach(() => {
  fixture.presentation = {};
  fixture.revision = 0;
  fixture.copy.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

it('rechecks current plugin copy restrictions after selecting an idle source', () => {
  fixture.presentation = { copyAllowed: false };
  const props = options();
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
  const props = options();
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
