// @vitest-environment jsdom

import type { DragEndEvent } from '@dnd-kit/core';
import { configureStore } from '@reduxjs/toolkit';
import { SESSION_HISTORY_GROUPING_PREFERENCE_KEY } from '@shared/app/rendererPreferences';
import {
  type AutomaticErrorRetryActivitySnapshot,
  AutomaticErrorRetryPhase as RetryPhase,
  type AutomaticErrorRetryPresentation,
} from '@shared/cowork/automaticErrorRetry';
import { SESSION_LIST_PAGE_SIZE } from '@shared/cowork/sessionDirectory';
import { CoworkSessionSource } from '@shared/cowork/sessionSource';
import { ExternalSessionSource, ExternalSessionStatus } from '@shared/integrations/externalSession';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { Provider, useSelector } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import coworkReducer, {
  setGroups,
  setSessionDirectory,
  setSessionRuntimeSnapshot,
  setSessions,
  toggleGroupExpanded,
  touchSessionActivity,
} from '@/features/cowork/coworkSlice';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { translations } from '@/services/i18n/translations';
import { rendererPreferences } from '@/services/rendererPreferences';

import CoworkSessionList from './CoworkSessionList';

const dragHandlers = vi.hoisted(() => ({
  onDragEnd: undefined as ((event: DragEndEvent) => void) | undefined,
}));
vi.mock('@dnd-kit/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      dragHandlers.onDragEnd = props.onDragEnd;
      return <actual.DndContext {...props} />;
    },
  };
});

const activities = vi.hoisted(() => ({
  presentation: {} as Record<string, { status?: 'running'; updatedAt?: number }>,
  revision: 0,
  listeners: new Set<() => void>(),
}));
vi.mock('@/features/plugins/app/runtime', () => ({
  appBrowserRegistry: {
    subscribe: (listener: () => void) => {
      activities.listeners.add(listener);
      return () => activities.listeners.delete(listener);
    },
    getContextRevision: () => activities.revision,
    sessionPresentation: (id: string) => activities.presentation[id] ?? {},
    sessionNavigation: () => undefined,
  },
}));
const notifyPresentation = () => {
  activities.revision++;
  activities.listeners.forEach(listener => listener());
};
vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: {
    ensureSessionSummaries: vi.fn(async () => true),
    readSessionSummaryPage: vi.fn(async () => true),
    moveSessionToGroup: vi.fn(async () => true),
  },
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.en[key] ?? key },
}));

afterEach(() => {
  cleanup();
  rendererPreferences.removeItem(SESSION_HISTORY_GROUPING_PREFERENCE_KEY);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  activities.presentation = {};
  vi.mocked(coworkService.ensureSessionSummaries).mockReset().mockResolvedValue(true);
  vi.mocked(coworkService.readSessionSummaryPage).mockReset().mockResolvedValue(true);
  vi.mocked(coworkService.moveSessionToGroup).mockReset().mockResolvedValue(true);
  dragHandlers.onDragEnd = undefined;
});

describe('session list pages', () => {
  it('reads one raw workspace page per action and keeps filtered slots in the page boundary', async () => {
    const now = Date.now() - 12 * 86_400_000;
    const raw = Array.from({ length: SESSION_LIST_PAGE_SIZE * 2 + 2 }, (_, index) => ({
      ...summary(`Workspace chat ${index}`, now - index),
      cwd: index % 2 ? 'e:/WORK/project/' : 'E:\\work\\project',
    }));
    const shown = [raw[0], raw[SESSION_LIST_PAGE_SIZE - 1], ...raw.slice(SESSION_LIST_PAGE_SIZE * 2)];
    const pinned = { ...summary('Pinned chat', now), cwd: raw[0].cwd, pinned: true };
    const store = createStore();
    const onVisibleSessionIdsChange = vi.fn();
    store.dispatch(setSessions([pinned]));
    const ConnectedList = () => {
      const sessions = useSelector((state: ReturnType<typeof store.getState>) => state.cowork.sessions);
      return (
        <CoworkSessionList
          {...createProps(sessions)}
          directory={[...shown, pinned]}
          workspaceDirectory={[...raw, pinned]}
          groupRecentSessionsByDate
          onVisibleSessionIdsChange={onVisibleSessionIdsChange}
        />
      );
    };
    vi.mocked(coworkService.readSessionSummaryPage).mockImplementation(async (ids, isVisible) => {
      store.dispatch(setSessions([pinned, ...raw.filter(row =>
        (ids.includes(row.id) && isVisible(row.id)) ||
        store.getState().cowork.sessions.some(session => session.id === row.id),
      )]));
      return true;
    });
    render(<Provider store={store}><ConnectedList /></Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Group by workspace' }));
    const group = screen.getByRole('button', { name: /^project · 4/i }).closest('section')!;
    const more = await within(group).findByRole('button', { name: 'Show more' });
    expect(within(group).getByText(shown[1].title)).toBeTruthy();
    expect(within(group).queryByText(shown[2].title)).toBeNull();
    expect(within(group).queryByText(raw[1].title)).toBeNull();
    expect(onVisibleSessionIdsChange).toHaveBeenLastCalledWith([pinned.id, shown[0].id, shown[1].id]);
    expect(coworkService.readSessionSummaryPage).toHaveBeenCalledExactlyOnceWith(
      raw.slice(0, SESSION_LIST_PAGE_SIZE).map(entry => entry.id), expect.any(Function),
    );

    fireEvent.click(more);
    await within(group).findByRole('button', { name: 'Show more' });
    expect(within(group).queryByText(shown[2].title)).toBeNull();
    expect(coworkService.readSessionSummaryPage).toHaveBeenNthCalledWith(
      2, raw.slice(SESSION_LIST_PAGE_SIZE, SESSION_LIST_PAGE_SIZE * 2).map(entry => entry.id), expect.any(Function),
    );
    expect(coworkService.readSessionSummaryPage).toHaveBeenCalledTimes(2);

    fireEvent.click(within(group).getByRole('button', { name: 'Show more' }));
    expect(await within(group).findByText(shown[3].title)).toBeTruthy();
    expect(coworkService.readSessionSummaryPage).toHaveBeenNthCalledWith(
      3, shown.slice(2).map(entry => entry.id), expect.any(Function),
    );
    expect(within(group).queryByRole('button', { name: 'Show more' })).toBeNull();
    const pinnedGroup = screen.getByRole('button', { name: /^Pinned · 1/ });
    fireEvent.click(pinnedGroup);
    fireEvent.click(screen.getByRole('button', { name: 'Group by time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Group by workspace' }));
    expect(pinnedGroup.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(shown[3].title)).toBeTruthy();
    const newChat = { ...summary('New workspace chat', Date.now()), cwd: pinned.cwd };
    raw.unshift(newChat);
    shown.unshift(newChat);
    act(() => store.dispatch(setSessions([newChat, ...store.getState().cowork.sessions])));
    expect(screen.getByText(newChat.title)).toBeTruthy();
    expect(within(group).queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(coworkService.readSessionSummaryPage).toHaveBeenCalledTimes(3);
    expect(coworkService.ensureSessionSummaries).not.toHaveBeenCalled();
    expect(rendererPreferences.getItem(SESSION_HISTORY_GROUPING_PREFERENCE_KEY)).toBe('workspace');
  });

  it('hydrates a previously unloaded workspace conversation when activity moves it into the leading raw page', async () => {
    rendererPreferences.setItem(SESSION_HISTORY_GROUPING_PREFERENCE_KEY, 'workspace');
    const now = Date.now();
    const directory = Array.from({ length: SESSION_LIST_PAGE_SIZE + 1 }, (_, index) => ({
      ...summary(`Recent chat ${index}`, now - index),
      cwd: 'E:\\project',
    }));
    const older = directory.at(-1)!;
    const store = createStore();
    const ConnectedList = () => {
      const entries = useSelector((state: ReturnType<typeof store.getState>) => state.cowork.sessionDirectory);
      const sessions = useSelector((state: ReturnType<typeof store.getState>) => state.cowork.sessions);
      return <CoworkSessionList {...createProps(sessions)} directory={entries ?? []} groupRecentSessionsByDate />;
    };
    store.dispatch(setSessionDirectory(directory));
    vi.mocked(coworkService.readSessionSummaryPage).mockImplementation(async ids => {
      store.dispatch(setSessions(directory.filter(entry => ids.includes(entry.id))));
      return true;
    });
    vi.mocked(coworkService.ensureSessionSummaries).mockImplementation(async () => {
      store.dispatch(setSessions([...store.getState().cowork.sessions, older]));
      return true;
    });
    render(<Provider store={store}><ConnectedList /></Provider>);
    await screen.findByRole('button', { name: 'Show more' });
    expect(screen.queryByText(older.title)).toBeNull();
    expect(coworkService.ensureSessionSummaries).not.toHaveBeenCalled();

    act(() => store.dispatch(touchSessionActivity({ sessionId: older.id, timestamp: now + 1 })));

    expect(await screen.findByText(older.title)).toBeTruthy();
    expect(coworkService.ensureSessionSummaries).toHaveBeenCalledExactlyOnceWith([older.id]);
    expect(coworkService.readSessionSummaryPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('keeps complete counts while requesting only expanded date pages and retains page size after collapse', async () => {
    const now = Date.now();
    const historical = Array.from({ length: 45 }, (_, index) =>
      summary(`Historical ${index + 1}`, now - 12 * 86_400_000 - index),
    );
    const today = summary('Today chat', now);
    const sessions = [today, ...historical];
    const directory = sessions.map(({ title: _title, ...entry }) => entry);
    const store = createStore();
    const onVisibleSessionIdsChange = vi.fn();
    const ConnectedList = () => {
      const summaries = useSelector(
        (state: ReturnType<typeof store.getState>) => state.cowork.sessions,
      );
      return (
        <CoworkSessionList
          {...createProps(summaries)}
          directory={directory}
          groupRecentSessionsByDate
          onVisibleSessionIdsChange={onVisibleSessionIdsChange}
        />
      );
    };
    vi.mocked(coworkService.ensureSessionSummaries).mockImplementation(async ids => {
      store.dispatch(
        setSessions([
          ...store.getState().cowork.sessions,
          ...sessions.filter(session => ids.includes(session.id)),
        ]),
      );
      return true;
    });
    render(
      <Provider store={store}>
        <ConnectedList />
      </Provider>,
    );
    await waitFor(() => expect(screen.getByText('Today chat')).toBeTruthy());
    expect(coworkService.ensureSessionSummaries).toHaveBeenCalledExactlyOnceWith(['Today chat']);
    const group = screen.getByRole('button', { name: /^Previous 30 Days · 45/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(group);
    await waitFor(() => expect(screen.getByText('Historical 20')).toBeTruthy());
    expect(screen.queryByText('Historical 21')).toBeNull();
    expect(vi.mocked(coworkService.ensureSessionSummaries).mock.calls[1][0]).toHaveLength(20);
    expect(onVisibleSessionIdsChange).toHaveBeenLastCalledWith([
      today.id,
      ...historical.slice(0, 20).map(session => session.id),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByText('Historical 40')).toBeTruthy());
    expect(screen.queryByText('Historical 41')).toBeNull();
    fireEvent.click(group);
    expect(screen.queryByText('Historical 40')).toBeNull();
    expect(onVisibleSessionIdsChange).toHaveBeenLastCalledWith([today.id]);
    const calls = vi.mocked(coworkService.ensureSessionSummaries).mock.calls.length;
    fireEvent.click(group);
    await waitFor(() => expect(screen.getByText('Historical 40')).toBeTruthy());
    expect(vi.mocked(coworkService.ensureSessionSummaries).mock.calls).toHaveLength(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByText('Historical 45')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('pages manual and source groups separately while keeping the full header totals', () => {
    const store = createStore();
    store.dispatch(
      setGroups([{ id: 'work', name: 'Work', color: '#359daf', sortOrder: 0, createdAt: 1 }]),
    );
    const manual = Array.from({ length: 24 }, (_, index) => ({
      ...summary(`Manual ${index + 1}`, 100 - index),
      groupId: 'work',
    }));
    const browser = Array.from({ length: 25 }, (_, index) => ({
      ...summary(`Browser ${index + 1}`, 100 - index),
      source: CoworkSessionSource.ChromeExtension,
    }));
    render(
      <Provider store={store}>
        <CoworkSessionList {...createProps([...manual, ...browser])} groupRecentSessionsByDate />
      </Provider>,
    );
    const manualHeader = screen.getByText('Work').closest('.session-group-header')!;
    const browserHeader = screen.getByRole('button', { name: /^Chrome\s*25$/ });
    fireEvent.click(manualHeader);
    expect(screen.getByText('Manual 20')).toBeTruthy();
    expect(screen.queryByText('Manual 21')).toBeNull();
    expect(screen.queryByText('Browser 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText('Manual 24')).toBeTruthy();
    fireEvent.click(browserHeader);
    expect(screen.getByText('Browser 20')).toBeTruthy();
    expect(screen.queryByText('Browser 21')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText('Browser 25')).toBeTruthy();
  });

  it('preserves loaded rows after a page failure and retries only missing summaries', async () => {
    const now = Date.now();
    const sessions = Array.from({ length: 25 }, (_, index) =>
      summary(`History ${index + 1}`, now - 12 * 86_400_000 - index),
    );
    const directory = sessions.map(({ title: _title, ...entry }) => entry);
    const store = createStore();
    store.dispatch(setSessions(sessions.slice(0, 20)));
    const ConnectedList = () => {
      const summaries = useSelector(
        (state: ReturnType<typeof store.getState>) => state.cowork.sessions,
      );
      return (
        <CoworkSessionList
          {...createProps(summaries)}
          directory={directory}
          groupRecentSessionsByDate
        />
      );
    };
    vi.mocked(coworkService.ensureSessionSummaries).mockResolvedValueOnce(false);
    render(
      <Provider store={store}>
        <ConnectedList />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Previous 30 Days · 25/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
    expect(screen.getByText('History 20')).toBeTruthy();
    expect(screen.queryByText('History 21')).toBeNull();
    vi.mocked(coworkService.ensureSessionSummaries).mockImplementation(async ids => {
      store.dispatch(setSessions(sessions));
      expect(ids).toEqual(sessions.slice(20).map(session => session.id));
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('History 25')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('uses unloaded Team member directory activity when classifying its anchor', () => {
    const now = Date.now();
    const anchor = summary('Team anchor', now - 40 * 86_400_000);
    const member = summary('Hidden member', now);
    const store = createStore();
    store.dispatch(setSessionDirectory([anchor, member]));
    activities.presentation[anchor.id] = { updatedAt: member.updatedAt };
    render(
      <Provider store={store}>
        <CoworkSessionList
          {...createProps([anchor])}
          directory={[anchor]}
          groupRecentSessionsByDate
        />
      </Provider>,
    );
    const today = screen.getByRole('button', { name: /^Today · 1/ }).closest('section')!;
    expect(within(today).getByText(anchor.title)).toBeTruthy();
    expect(screen.queryByText(member.title)).toBeNull();
    expect(coworkService.ensureSessionSummaries).not.toHaveBeenCalled();
  });
});

const summary = (id: string, updatedAt: number): CoworkSessionSummary => ({
  id,
  title: id,
  status: 'idle',
  pinned: false,
  createdAt: updatedAt,
  updatedAt,
});
const browserSessions: CoworkSessionSummary[] = [
  { ...summary('Browser older', 1), source: CoworkSessionSource.ChromeExtension },
  {
    ...summary('Browser newer', 2),
    source: CoworkSessionSource.ChromeExtension,
    pinned: true,
    groupId: 'work',
  },
];
const createProps = (sessions: CoworkSessionSummary[]) => ({
  sessions,
  currentSessionId: null as string | null,
  isBatchMode: false,
  selectedIds: new Set<string>(),
  showCreateGroupButton: false,
  onSelectSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onRenameSession: vi.fn(),
  onExportSession: vi.fn(),
  onCopySession: vi.fn(),
  onToggleSelection: vi.fn(),
  onEnterBatchMode: vi.fn(),
});
const createStore = () =>
  configureStore({
    reducer: { cowork: coworkReducer, agent: () => ({ agents: [] }) },
  });

describe('fixed source group membership', () => {
  const dragTo = async (sessionId: string, targetId: string) => {
    await act(async () => {
      await dragHandlers.onDragEnd!({
        active: { id: sessionId },
        over: { id: targetId },
      } as DragEndEvent);
    });
  };
  const renderWithManualGroup = (session: CoworkSessionSummary) => {
    const store = createStore();
    store.dispatch(setSessions([session]));
    store.dispatch(
      setGroups([{ id: 'work', name: 'Work', color: '#359daf', sortOrder: 0, createdAt: 1 }]),
    );
    render(
      <Provider store={store}>
        <CoworkSessionList {...createProps([session])} />
      </Provider>,
    );
    return store;
  };

  it.each([
    { source: CoworkSessionSource.ChromeExtension },
    {
      external: {
        origin: ExternalSessionSource.Cli,
        readOnly: true as const,
        status: ExternalSessionStatus.Completed,
        sessionKey: 'key',
      },
    },
  ])(
    'rejects dragging a source conversation to a manual group or ungrouped: %j',
    async metadata => {
      renderWithManualGroup({ ...summary('Source chat', 1), ...metadata });
      await dragTo('Source chat', 'group-work');
      await dragTo('Source chat', 'ungrouped');
      expect(coworkService.moveSessionToGroup).not.toHaveBeenCalled();
    },
  );

  it.each(['cli', 'chromeExtension', 'missing'])(
    'rejects moving a regular conversation into a nonmanual target %s',
    async targetId => {
      const store = renderWithManualGroup(summary('Regular chat', 1));
      await dragTo('Regular chat', 'group-' + targetId);
      expect(coworkService.moveSessionToGroup).not.toHaveBeenCalled();
      expect(store.getState().cowork.sessions[0].groupId).toBeUndefined();
    },
  );

  it('keeps the current membership when Main rejects a move', async () => {
    const store = renderWithManualGroup(summary('Regular chat', 1));
    vi.mocked(coworkService.moveSessionToGroup).mockResolvedValue(false);
    await dragTo('Regular chat', 'group-work');
    expect(coworkService.moveSessionToGroup).toHaveBeenCalledExactlyOnceWith(
      'Regular chat',
      'work',
    );
    expect(store.getState().cowork.sessions[0].groupId).toBeUndefined();
  });

  it('continues to allow moving a regular conversation into and out of a manual group', async () => {
    renderWithManualGroup(summary('Regular chat', 1));
    await dragTo('Regular chat', 'group-work');
    await dragTo('Regular chat', 'ungrouped');
    expect(coworkService.moveSessionToGroup).toHaveBeenNthCalledWith(1, 'Regular chat', 'work');
    expect(coworkService.moveSessionToGroup).toHaveBeenNthCalledWith(2, 'Regular chat', null);
  });
});

it.each([1, 3, 15, 60])(
  'moves a conversation from %i days ago to the top of Today and keeps it there after a stale refresh',
  daysAgo => {
    vi.useFakeTimers();
    const now = new Date(2026, 9, 16, 12).getTime();
    vi.setSystemTime(now);
    const history = summary('Historical chat', now - daysAgo * 86_400_000);
    const today = summary('Today chat', now - 60_000);
    const store = createStore();
    store.dispatch(setSessions([history, today]));
    const props = { ...createProps([]), currentSessionId: history.id };
    const ConnectedList = () => {
      const sessions = useSelector(
        (state: ReturnType<typeof store.getState>) => state.cowork.sessions,
      );
      return <CoworkSessionList {...props} sessions={sessions} groupRecentSessionsByDate />;
    };
    render(
      <Provider store={store}>
        <ConnectedList />
      </Provider>,
    );
    const todaySection = () => screen.getByRole('button', { name: /^Today ·/ }).closest('section')!;
    expect(within(todaySection()).queryByText(history.title)).toBeNull();

    act(() => {
      store.dispatch(touchSessionActivity({ sessionId: history.id, timestamp: now }));
    });

    const titles = () =>
      within(todaySection())
        .getAllByRole('button')
        .slice(1)
        .map(button => button.textContent);
    expect(titles()).toEqual([history.title, today.title]);
    act(() => {
      store.dispatch(setSessions([history, today]));
    });
    expect(titles()).toEqual([history.title, today.title]);
  },
);

it('removes the spinner without adding a status label when an external session becomes inactive', () => {
  const store = createStore();
  const session: CoworkSessionSummary = {
    ...summary('External chat', 1),
    status: 'running',
    external: {
      origin: ExternalSessionSource.Cli,
      readOnly: true,
      status: ExternalSessionStatus.Running,
      sessionKey: 'key',
    },
  };
  store.dispatch(setSessionDirectory([session]));
  render(
    <Provider store={store}>
      <CoworkSessionList {...createProps([session])} currentSessionId={session.id} />
    </Provider>,
  );
  const indicator = () => within(screen.getByRole('button', { name: session.title }))
    .queryByTitle(translations.en.coworkStatusRunning);
  const ended = () => within(screen.getByRole('button', { name: session.title }))
    .queryByText(translations.en.coworkStatusEnded);
  expect(indicator()).toBeNull();
  expect(ended()).toBeNull();

  act(() => {
    store.dispatch(setSessionRuntimeSnapshot({
      sessionId: session.id,
      snapshot: { revision: 1, known: true, mainRunning: true, subagentRunning: false, running: true },
    }));
  });
  expect(indicator()).toBeTruthy();
  expect(ended()).toBeNull();

  act(() => {
    store.dispatch(setSessionRuntimeSnapshot({
      sessionId: session.id,
      snapshot: { revision: 2, known: true, mainRunning: false, subagentRunning: false, running: false },
    }));
    store.dispatch(setSessionDirectory([session]));
  });
  expect(indicator()).toBeNull();
  expect(ended()).toBeNull();

  act(() => {
    store.dispatch(setSessionRuntimeSnapshot({
      sessionId: session.id,
      snapshot: { revision: 3, known: true, mainRunning: true, subagentRunning: false, running: true },
    }));
  });
  expect(indicator()).toBeTruthy();
  expect(ended()).toBeNull();
});

it('shows source activity for background Team, discussions and Swarm without changing main execution state', () => {
  activities.presentation = {
    Team: { status: 'running' },
    Discussion: { status: 'running' },
    Swarm: { status: 'running' },
  };
  const store = createStore();
  store.dispatch(
    setSessionRuntimeSnapshot({
      sessionId: 'peer',
      snapshot: {
        revision: 1,
        known: true,
        mainRunning: false,
        subagentRunning: true,
        running: true,
      },
    }),
  );
  const props = createProps(['Team', 'Discussion', 'Swarm', 'Idle'].map(id => summary(id, 1)));
  const view = () => (
    <Provider store={store}>
      <CoworkSessionList {...props} />
    </Provider>
  );
  render(view());
  for (const id of ['Team', 'Discussion', 'Swarm']) {
    expect(
      within(screen.getByRole('button', { name: id })).getByTitle(
        translations.en.coworkStatusRunning,
      ),
    ).toBeTruthy();
  }
  expect(
    within(screen.getByRole('button', { name: 'Idle' })).queryByTitle(
      translations.en.coworkStatusRunning,
    ),
  ).toBeNull();
  expect(store.getState().cowork.sessionMainRuntimeActivity).toEqual({});
  act(() => {
    activities.presentation = {};
    notifyPresentation();
  });
  expect(screen.queryByTitle(translations.en.coworkStatusRunning)).toBeNull();
});

it('updates plugin activity without granting main execution state', () => {
  const store = createStore();
  const props = createProps([summary('Source', 1)]);
  render(
    <Provider store={store}>
      <CoworkSessionList {...props} />
    </Provider>,
  );
  const indicator = () =>
    within(screen.getByRole('button', { name: 'Source' })).queryByTitle(
      translations.en.coworkStatusRunning,
    );
  expect(indicator()).toBeNull();
  act(() => {
    activities.presentation.Source = { status: 'running' };
    notifyPresentation();
  });
  expect(indicator()).toBeTruthy();
  expect(store.getState().cowork.sessionMainRuntimeActivity).toEqual({});
  act(() => {
    activities.presentation = {};
    notifyPresentation();
  });
  expect(indicator()).toBeNull();
});

it('keeps retry waits visible for background rows and reconciles live changes with the initial snapshot', async () => {
  const store = createStore();
  const props = createProps(['Selected', 'Already waiting', 'Stopped', 'New retry'].map(id => summary(id, 1)));
  let resolveSnapshot!: (snapshot: AutomaticErrorRetryActivitySnapshot) => void;
  let onChanged!: (presentation: AutomaticErrorRetryPresentation) => void;
  const getAutomaticErrorRetryActivity = vi.fn(() => new Promise<AutomaticErrorRetryActivitySnapshot>(resolve => {
    resolveSnapshot = resolve;
  }));
  const remove = vi.fn();
  vi.stubGlobal('electron', { cowork: {
    getAutomaticErrorRetryActivity,
    onAutomaticErrorRetryChanged: (listener: typeof onChanged) => { onChanged = listener; return remove; },
  } });
  const { unmount } = render(
    <Provider store={store}>
      <CoworkSessionList {...props} currentSessionId="Selected" />
    </Provider>,
  );
  const indicator = (id: string) => within(screen.getByRole('button', { name: id }))
    .queryByTitle(translations.en.coworkStatusRunning);
  const publish = (sessionId: string, revision: number, phase: RetryPhase) => onChanged({
    sessionId, revision, phase, chainId: sessionId, attempt: 0, maxContinuations: 3, runs: [],
  });

  act(() => {
    publish('Stopped', 5, RetryPhase.Cancelled);
    publish('New retry', 6, RetryPhase.Checking);
  });
  expect(indicator('New retry')).toBeTruthy();

  await act(async () => resolveSnapshot({ revision: 4, sessionIds: ['Already waiting', 'Stopped'] }));
  expect(indicator('Already waiting')).toBeTruthy();
  expect(indicator('Stopped')).toBeNull();
  expect(indicator('New retry')).toBeTruthy();
  expect(indicator('Selected')).toBeNull();

  act(() => {
    publish('Already waiting', 7, RetryPhase.Completed);
    publish('New retry', 8, RetryPhase.Failed);
    publish('Stopped', 4, RetryPhase.Checking);
    publish('Selected', 3, RetryPhase.Checking);
  });
  expect(screen.queryByTitle(translations.en.coworkStatusRunning)).toBeNull();
  expect(store.getState().cowork.sessionRuntimeActivity).toEqual({});
  expect(getAutomaticErrorRetryActivity).toHaveBeenCalledOnce();
  unmount();
  expect(remove).toHaveBeenCalledOnce();
});

describe('sidebar browser extension group', () => {
  it('shows Chrome and External source groups and keeps browser sessions out of manual groups', () => {
    const store = createStore();
    store.dispatch(
      setGroups([{ id: 'work', name: 'Work', color: '#359daf', sortOrder: 0, createdAt: 1 }]),
    );
    store.dispatch(toggleGroupExpanded('work'));
    const props = createProps([
      ...browserSessions,
      summary('Desktop chat', 3),
      {
        ...summary('CLI chat', 4),
        external: {
          origin: 'cli',
          readOnly: true,
          status: 'completed',
          sessionKey: 'cli:one',
        },
      },
    ]);
    render(
      <Provider store={store}>
        <CoworkSessionList {...props} />
      </Provider>,
    );

    const browserGroup = screen.getByRole('button', { name: /^Chrome\s*2$/ });
    expect(browserGroup.getAttribute('aria-expanded')).toBe('false');
    expect(within(browserGroup).getByText('2')).toBeTruthy();
    expect(screen.queryByText('Browser newer')).toBeNull();
    expect(screen.queryByText('Browser older')).toBeNull();
    expect(screen.getByText('Desktop chat')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^External\s*1$/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByRole('button', { name: /^CLI\s*1$/ })).toBeNull();
    expect(
      screen
        .getAllByRole('button')
        .filter(button => button.classList.contains('session-group-header'))
        .map(button => button.textContent),
    ).toEqual(['External1', 'Chrome2', 'Work0']);

    fireEvent.click(browserGroup);
    const panel = browserGroup.nextElementSibling as HTMLElement;
    expect(within(panel).getByText('Browser newer')).toBeTruthy();
    expect(within(panel).getByText('Browser older')).toBeTruthy();
    expect(screen.getAllByText('Browser newer')).toHaveLength(1);
    expect(screen.queryByText('CLI chat')).toBeNull();
    fireEvent.click(screen.getByText('Browser newer'));
    expect(props.onSelectSession).toHaveBeenCalledWith('Browser newer');
    fireEvent.click(browserGroup);
    expect(screen.queryByText('Browser newer')).toBeNull();
  });

  it('opens the External group when a CLI conversation is selected', () => {
    const cli: CoworkSessionSummary = {
      ...summary('CLI chat', 1),
      external: {
        origin: 'cli',
        readOnly: true,
        status: 'completed',
        sessionKey: 'agent:main:cli:original',
      },
    };
    const store = createStore();
    const props = { ...createProps([cli]), currentSessionId: cli.id };
    render(
      <Provider store={store}>
        <CoworkSessionList {...props} />
      </Provider>,
    );

    const group = screen.getByRole('button', { name: /^External\s*1$/ });
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: /^CLI\s*1$/ })).toBeNull();
    fireEvent.click(screen.getByText(cli.title));
    expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith(cli.id);
    expect(cli.external).toEqual({
      origin: 'cli',
      readOnly: true,
      status: 'completed',
      sessionKey: 'agent:main:cli:original',
    });
  });

  it('opens the active browser group and respects manual collapse through list refreshes', () => {
    const store = createStore();
    const props = { ...createProps(browserSessions), currentSessionId: 'Browser older' };
    const { rerender } = render(
      <Provider store={store}>
        <CoworkSessionList {...props} />
      </Provider>,
    );
    const browserGroup = screen.getByRole('button', { name: /^Chrome\s*2$/ });
    expect(browserGroup.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('Recent Chats')).toBeNull();

    fireEvent.click(browserGroup);
    rerender(
      <Provider store={store}>
        <CoworkSessionList
          {...props}
          sessions={browserSessions.map(session => ({ ...session, updatedAt: 5 }))}
        />
      </Provider>,
    );
    expect(browserGroup.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Browser older')).toBeNull();

    rerender(
      <Provider store={store}>
        <CoworkSessionList {...props} currentSessionId="Browser newer" />
      </Provider>,
    );
    expect(browserGroup.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Browser newer')).toBeTruthy();
  });

  it('omits the browser source group when there are no extension conversations', () => {
    render(
      <Provider store={createStore()}>
        <CoworkSessionList {...createProps([summary('Desktop chat', 1)])} />
      </Provider>,
    );
    expect(screen.queryByRole('button', { name: /^Chrome\s*\d+$/ })).toBeNull();
    expect(screen.getByText('Desktop chat')).toBeTruthy();
  });
});
