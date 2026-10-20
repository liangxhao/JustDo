// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';

import type { TeamDiscussionRoom } from '../../contracts/teamDiscussion';
import { openAgentTeam } from '../navigation';
import {
  OPEN_TEAM_PANEL,
  openTeamPanel,
  prepareDiscussionSource,
  useTeamDiscussionRoomsState,
} from './teamDiscussionNavigation';

const state = vi.hoisted(() => ({ currentSession: { id: 'source' } }));
vi.mock('@/store', () => ({ store: { getState: () => ({ cowork: state }) } }));
vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: { loadSession: vi.fn() },
}));
vi.mock('../navigation', () => ({ openAgentTeam: vi.fn() }));
const room = { id: 'room', sourceSessionId: 'source' } as TeamDiscussionRoom;
const transition = vi.fn();
const isCurrent = vi.fn();
const navigation = { requestTransition: transition, isCurrent };

beforeEach(() => {
  vi.resetAllMocks();
  state.currentSession = { id: 'source' };
  transition.mockResolvedValue(true);
  isCurrent.mockReturnValue(true);
  vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
    if (state.currentSession.id === 'source') options?.onSelected?.();
    return { id: 'source' } as never;
  });
});
afterEach(cleanup);

it('keeps failed discussion lists unconfirmed until a complete successful list arrives', async () => {
  const list = vi.fn().mockResolvedValue({ success: false });
  let refresh!: () => void;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      teamDiscussion: { list },
      cowork: { onSessionsChanged: (listener: () => void) => {
        refresh = listener;
        return () => undefined;
      } },
    },
  });
  const hook = renderHook(() => useTeamDiscussionRoomsState());
  expect(hook.result.current).toEqual({ rooms: [], ready: false });
  await act(async () => {});
  expect(hook.result.current.ready).toBe(false);
  list.mockResolvedValue({ success: true, value: [room] });
  await act(async () => refresh());
  expect(hook.result.current).toEqual({ rooms: [room], ready: true });
  list.mockRejectedValue(new Error('disconnected'));
  await act(async () => refresh());
  expect(hook.result.current).toEqual({ rooms: [room], ready: false });
  list.mockResolvedValue({ success: true, value: [] });
  await act(async () => refresh());
  expect(hook.result.current).toEqual({ rooms: [], ready: true });
  hook.unmount();
  list.mockResolvedValue({ success: false });
  const renewed = renderHook(() => useTeamDiscussionRoomsState());
  await act(async () => {});
  expect(renewed.result.current).toEqual({ rooms: [], ready: false });
});

it('preserves the unsaved file navigation guard for linked and standalone discussions', async () => {
  transition.mockResolvedValue(false);
  await openTeamPanel(room, navigation);
  await openTeamPanel({ ...room, sourceSessionId: undefined }, navigation);
  expect(coworkService.loadSession).not.toHaveBeenCalled();
  expect(openAgentTeam).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith({ preserveTabs: true });
});

it('opens the embedded team panel only after loading the current source', async () => {
  const received = vi.fn();
  window.addEventListener(OPEN_TEAM_PANEL, received);
  try {
    await openTeamPanel(room, navigation);
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0][0].detail).toEqual({ sessionId: 'source', roomId: 'room' });
    expect(openAgentTeam).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(OPEN_TEAM_PANEL, received);
  }
});

it('keeps retained group history accessible after its source task is deleted', async () => {
  vi.mocked(coworkService.loadSession).mockResolvedValue(null);
  await openTeamPanel(room, navigation);
  expect(openAgentTeam).toHaveBeenCalledWith({ roomId: 'room' });
});

it('falls back to the room when loading the organizing task fails', async () => {
  vi.mocked(coworkService.loadSession).mockRejectedValue(new Error('disconnected'));
  await openTeamPanel(room, navigation);
  expect(openAgentTeam).toHaveBeenCalledWith({ roomId: 'room' });
});

it('does not open a panel for a superseded navigation or stale session load', async () => {
  const received = vi.fn();
  window.addEventListener(OPEN_TEAM_PANEL, received);
  try {
    isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(coworkService.loadSession).mockResolvedValueOnce(null);
    await openTeamPanel(room, navigation);
    isCurrent.mockReturnValue(true);
    state.currentSession = { id: 'other' };
    await openTeamPanel(room, navigation);
    expect(received).not.toHaveBeenCalled();
    expect(openAgentTeam).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(OPEN_TEAM_PANEL, received);
  }
});

it.each(['open', 'prepare'] as const)(
  'prevents a delayed %s from selecting a source after its navigation is superseded',
  async action => {
    const prepare = vi.fn();
    let finish!: () => void;
    vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      if (options?.canSelect?.() === false) return null;
      state.currentSession = { id: 'source' };
      options?.onSelected?.();
      return state.currentSession as never;
    });
    const result =
      action === 'open'
        ? openTeamPanel(room, navigation)
        : prepareDiscussionSource('source', navigation, prepare);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state.currentSession = { id: 'other' };
    isCurrent.mockReturnValue(false);
    finish();
    await result;
    expect(state.currentSession.id).toBe('other');
    expect(prepare).not.toHaveBeenCalled();
    expect(openAgentTeam).not.toHaveBeenCalled();
  },
);

it('prepares a source draft only after successful guarded navigation', async () => {
  const prepare = vi.fn();
  transition.mockResolvedValueOnce(false);
  await prepareDiscussionSource('source', navigation, prepare);
  expect(coworkService.loadSession).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  await prepareDiscussionSource('source', navigation, prepare);
  expect(prepare).toHaveBeenCalledOnce();
  expect(coworkService.loadSession).toHaveBeenCalledWith('source', {
    canSelect: isCurrent,
    onSelected: expect.any(Function),
  });
});

it('commits the reference before source selection closes the group during hydration', async () => {
  const prepare = vi.fn();
  let finishHydration!: () => void;
  vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
    state.currentSession = { id: 'source' };
    options?.onSelected?.();
    // App's currentSessionId effect closes the standalone group after selection.
    isCurrent.mockReturnValue(false);
    await new Promise<void>(resolve => {
      finishHydration = resolve;
    });
    return state.currentSession as never;
  });
  const loading = prepareDiscussionSource('source', navigation, prepare);
  await vi.waitFor(() => expect(finishHydration).toBeTypeOf('function'));
  expect(prepare).toHaveBeenCalledOnce();
  finishHydration();
  await loading;
  expect(prepare).toHaveBeenCalledOnce();
});

it('does not prepare references for missing or superseded sources', async () => {
  const prepare = vi.fn();
  vi.mocked(coworkService.loadSession).mockResolvedValueOnce(null);
  await expect(prepareDiscussionSource('source', navigation, prepare)).rejects.toThrow(
    'teamDiscussionNotFound',
  );
  state.currentSession = { id: 'other' };
  await prepareDiscussionSource('source', navigation, prepare);
  expect(prepare).not.toHaveBeenCalled();
});

it.each([false, true])(
  'reports capacity errors after the group closes even if hydration fails=%s',
  async hydrationFails => {
    const reportError = vi.fn();
    vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
      let failure: unknown;
      try {
        options?.onSelected?.();
      } catch (error) {
        failure = error;
      }
      isCurrent.mockReturnValue(false);
      await Promise.resolve();
      throw hydrationFails ? new Error('transport disconnected') : failure;
    });
    await prepareDiscussionSource('source', { ...navigation, reportError }, () => {
      throw new Error('teamReferenceLimit');
    });
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0][0].message).toBe('teamReferenceLimit');
  },
);

it('does not report an already inserted reference as failed when later hydration fails', async () => {
  const prepare = vi.fn();
  const reportError = vi.fn();
  vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
    options?.onSelected?.();
    isCurrent.mockReturnValue(false);
    await Promise.resolve();
    throw new Error('transport disconnected');
  });
  await prepareDiscussionSource('source', { ...navigation, reportError }, prepare);
  expect(prepare).toHaveBeenCalledOnce();
  expect(reportError).not.toHaveBeenCalled();
});
