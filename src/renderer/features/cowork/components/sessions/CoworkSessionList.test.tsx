// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import type { CollaborationRoomEntry } from '@shared/cowork/agent-team/collaboration';
import type { TeamDiscussionRoom } from '@shared/cowork/agent-team/teamDiscussion';
import { CoworkSessionSource } from '@shared/cowork/sessionSource';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import coworkReducer, {
  setGroups,
  setSessionRuntimeSnapshot,
  setSessions,
  toggleGroupExpanded,
} from '@/features/cowork/coworkSlice';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { translations } from '@/services/i18n/translations';

import CoworkSessionList from './CoworkSessionList';

const activities = vi.hoisted(() => ({
  collaborations: [] as CollaborationRoomEntry[],
  discussions: [] as TeamDiscussionRoom[],
  workflows: {} as Record<string, boolean>,
}));
vi.mock('@/features/cowork/components/collaboration/CollaborationPanel', () => ({
  useCollaborationRooms: () => activities.collaborations,
}));
vi.mock('@/features/cowork/components/discussions/teamDiscussionNavigation', () => ({
  useTeamDiscussionRooms: () => activities.discussions,
}));
vi.mock('@/features/plugins/extensions/useExtensionEnablement', () => ({
  useExtensionAvailability: () => ({ enabled: false, disabledRevision: 0 }),
}));
vi.mock('@/features/cowork/components/swarm-workflow/useSwarmWorkflowActivity', () => ({
  useSwarmWorkflowActivity: () => activities.workflows,
}));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: {} }));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.en[key] ?? key },
}));

afterEach(() => {
  cleanup();
  activities.collaborations = [];
  activities.discussions = [];
  activities.workflows = {};
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
  { ...summary('Browser older', 1), source: CoworkSessionSource.BrowserExtension },
  {
    ...summary('Browser newer', 2),
    source: CoworkSessionSource.BrowserExtension,
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

it('shows source activity for background Team, discussions and Swarm without changing main execution state', () => {
  activities.collaborations = [
    {
      id: 'team',
      anchorSessionId: 'Team',
      members: [{ agentId: 'worker', sessionId: 'peer', sessionKey: 'peer-key' }],
      rounds: [{ id: 'batch', state: 'open', pending: 1 }],
    },
  ];
  activities.discussions = [
    { id: 'group', sourceSessionId: 'Discussion', state: 'running' } as TeamDiscussionRoom,
  ];
  activities.workflows = { Swarm: true };
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
  const { rerender } = render(view());
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
  activities.collaborations = [];
  activities.discussions = [];
  activities.workflows = {};
  rerender(view());
  expect(screen.queryByTitle(translations.en.coworkStatusRunning)).toBeNull();
});

it.each(['open', 'closing'] as const)(
  'follows actual Team activity while preserving a historical %s delivery without its terminal receipt',
  state => {
    const historical: CollaborationRoomEntry = {
      id: 'team',
      anchorSessionId: 'Team',
      members: [
        { agentId: 'source', sessionId: 'Team', sessionKey: 'source-key' },
        { agentId: 'worker', sessionId: 'peer', sessionKey: 'peer-key' },
      ],
      rounds: [{ id: 'historical', state, pending: 1 }],
    };
    activities.collaborations = [historical];
    const store = createStore();
    store.dispatch(setSessions([summary('Team', 1), summary('peer', 1)]));
    const props = createProps([summary('Team', 1)]);
    render(
      <Provider store={store}>
        <CoworkSessionList {...props} />
      </Provider>,
    );
    const indicator = () =>
      within(screen.getByRole('button', { name: 'Team' })).queryByTitle(
        translations.en.coworkStatusRunning,
      );
    expect(indicator()).toBeNull();

    act(() => {
      store.dispatch(
        setSessionRuntimeSnapshot({
          sessionId: 'peer',
          snapshot: {
            revision: 1,
            known: true,
            mainRunning: true,
            subagentRunning: false,
            running: true,
          },
        }),
      );
    });
    expect(indicator()).toBeTruthy();
    expect(store.getState().cowork.sessionMainRuntimeActivity.Team).toBeUndefined();

    act(() => {
      store.dispatch(
        setSessionRuntimeSnapshot({
          sessionId: 'peer',
          snapshot: {
            revision: 2,
            known: true,
            mainRunning: false,
            subagentRunning: false,
            running: false,
          },
        }),
      );
    });
    expect(indicator()).toBeNull();
    expect(historical.rounds).toEqual([{ id: 'historical', state, pending: 1 }]);
    expect(store.getState().cowork.sessionMainRuntimeActivity).toEqual({});
  },
);

describe('sidebar browser extension group', () => {
  it('defaults to collapsed, keeps browser sessions out of recent and user groups, and leaves Multica separate', () => {
    const store = createStore();
    store.dispatch(
      setGroups([{ id: 'work', name: 'Work', color: '#359daf', sortOrder: 0, createdAt: 1 }]),
    );
    store.dispatch(toggleGroupExpanded('work'));
    const props = createProps([
      ...browserSessions,
      summary('Desktop chat', 3),
      {
        ...summary('Multica chat', 4),
        external: {
          origin: 'multica',
          readOnly: true,
          status: 'completed',
          sessionKey: 'multica:one',
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
    expect(
      screen.getByRole('button', { name: /^Multica\s*1$/ }).getAttribute('aria-expanded'),
    ).toBe('false');

    fireEvent.click(browserGroup);
    const panel = browserGroup.nextElementSibling as HTMLElement;
    expect(within(panel).getByText('Browser newer')).toBeTruthy();
    expect(within(panel).getByText('Browser older')).toBeTruthy();
    expect(screen.getAllByText('Browser newer')).toHaveLength(1);
    expect(screen.queryByText('Multica chat')).toBeNull();
    fireEvent.click(screen.getByText('Browser newer'));
    expect(props.onSelectSession).toHaveBeenCalledWith('Browser newer');
    fireEvent.click(browserGroup);
    expect(screen.queryByText('Browser newer')).toBeNull();
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
