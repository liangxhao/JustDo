// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import type {
  CollaborationReview,
  CollaborationSnapshot,
} from '@shared/cowork/agent-team/collaboration';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoworkSession } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: { loadSessions: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./CollaborationMemberHistory', () => ({
  default: ({
    name,
    receipt,
    backAction,
    headerMenu,
    roomId,
  }: {
    name: string;
    receipt?: { id: string; deliveryId: string };
    backAction?: { label: string; onClick: () => void };
    headerMenu?: ReactNode;
    roomId?: string;
  }) => (
    <div>
      {backAction && <button onClick={backAction.onClick}>{backAction.label}</button>}
      {headerMenu}
      <div data-run-id={receipt?.id} data-delivery-id={receipt?.deliveryId} data-room-id={roomId}>
        History: {name}
      </div>
    </div>
  ),
}));
vi.mock('../composer/LocalSpeechInputButton', () => ({ LocalSpeechInputButton: () => null }));
import type { CollaborationContinueRequest } from './collaborationContinueDraft';
import CollaborationPanel, {
  CollaborationMemberLinks,
  useCollaborationRooms,
} from './CollaborationPanel';

it('uses a fresh full receipt snapshot for the exact continuation while preserving a newer member draft', async () => {
  const sourceId = `source-${crypto.randomUUID()}`;
  const room = {
    id: `room-${crypto.randomUUID()}`,
    anchorSessionId: sourceId,
    members: [
      {
        agentId: 'organizer',
        sessionId: sourceId,
        sessionKey: `agent:organizer:justdo:${sourceId}`,
      },
      {
        agentId: 'reviewer',
        sessionId: 'continuation-peer',
        sessionKey: 'agent:reviewer:justdo:continuation-peer',
      },
    ],
  };
  const prior = {
    id: 'prior',
    roomId: room.id,
    roundId: 'old-round',
    from: 'organizer',
    to: 'reviewer',
    toolCallId: 'old-call',
    sourceRunId: 'old-source',
    runId: 'old-peer',
    state: 'accepted' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const oldSnapshot: CollaborationSnapshot = {
    room,
    deliveries: [prior],
    rounds: [{ id: 'old-round', state: 'settled', pending: 0 }],
  };
  let settleRead!: (value: { success: true; value: CollaborationSnapshot }) => void;
  let waitForTerminal = false;
  const read = vi.fn(() =>
    waitForTerminal
      ? new Promise<{ success: true; value: CollaborationSnapshot }>(resolve => {
          settleRead = resolve;
        })
      : Promise.resolve({ success: true, value: oldSnapshot }),
  );
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { collaboration: { read } },
  });
  const state = { sessions: [], sessionRunTimings: {} as Record<string, SessionRunTiming[]> };
  const store = configureStore({
    reducer: {
      agent: () => ({
        agents: room.members.map(member => ({
          id: member.agentId,
          name: member.agentId,
          enabled: true,
        })),
      }),
      cowork: (current: typeof state = state, action) =>
        action.type === 'set-timing'
          ? { ...current, sessionRunTimings: { [sourceId]: [action.payload as SessionRunTiming] } }
          : current,
    },
  });
  const request = vi.fn(
    async (_room, _member, _delivery, _input: CollaborationContinueRequest) =>
      'source_accepted' as const,
  );
  render(
    <Provider store={store}>
      <CollaborationPanel
        source={{ id: sourceId, agentId: 'organizer' } as CoworkSession}
        roomId={room.id}
        roundId="old-round"
        selectedMemberId="continuation-peer"
        onSelect={vi.fn()}
        onFocusComposer={vi.fn()}
        onRequestContinue={request}
      />
    </Provider>,
  );
  const input = await screen.findByRole('textbox', { name: i18nService.t('teamContinueMessage') });
  fireEvent.change(input, { target: { value: 'Inspect revisions' } });
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('teamRequestContinue') }));
  await screen.findByText(i18nService.t('teamContinue_source_accepted'));
  const submitted = request.mock.calls[0][3];
  expect(request).toHaveBeenCalledWith(
    room,
    room.members[1],
    undefined,
    expect.objectContaining({ message: 'Inspect revisions', requestId: expect.any(String) }),
  );
  const timing: SessionRunTiming = {
    id: 'new-timing',
    sessionId: sourceId,
    clientTurnId: `justdo-continue-${submitted.requestId}`,
    rootRunId: 'exact-new-source',
    startedAt: 2,
    acceptedAt: 3,
    state: 'running',
  };
  await act(async () => {
    store.dispatch({ type: 'set-timing', payload: timing });
  });
  expect(screen.queryByText(i18nService.t('teamContinue_target_accepted'))).toBeNull();
  fireEvent.change(input, { target: { value: 'Newer draft stays here' } });
  waitForTerminal = true;
  await act(async () => {
    store.dispatch({ type: 'set-timing', payload: { ...timing, state: 'completed', endedAt: 5 } });
  });
  await waitFor(() => expect(settleRead).toBeTypeOf('function'));
  expect(screen.queryByText(i18nService.t('teamContinue_not_forwarded'))).toBeNull();
  await act(async () =>
    settleRead({
      success: true,
      value: {
        ...oldSnapshot,
        deliveries: [
          prior,
          {
            ...prior,
            id: 'actual',
            roundId: 'new-round',
            sourceRunId: 'exact-new-source',
            runId: 'real-peer',
          },
        ],
      },
    }),
  );
  await screen.findByText(i18nService.t('teamContinue_target_accepted'));
  expect((input as HTMLTextAreaElement).value).toBe('Newer draft stays here');
});

afterEach(cleanup);
describe('collaboration Stop entry points', () => {
  const snapshot: CollaborationSnapshot = {
    room: {
      id: 'stop-room',
      anchorSessionId: 'idle-source',
      members: [
        { agentId: 'main', sessionId: 'idle-source', sessionKey: 'agent:main:justdo:idle-source' },
        {
          agentId: 'review',
          sessionId: 'working-peer',
          sessionKey: 'agent:review:justdo:working-peer',
        },
      ],
    },
    rounds: [{ id: 'batch', state: 'open', pending: 1 }],
    deliveries: [],
  };
  const mount = (selectedMemberId?: string) => {
    const stop = vi.fn().mockResolvedValue({ success: true, value: undefined });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: {
          read: vi.fn().mockResolvedValue({ success: true, value: snapshot }),
          stop,
        },
      },
    });
    const store = configureStore({
      reducer: {
        agent: () => ({
          agents: [
            { id: 'main', name: 'Main' },
            { id: 'review', name: 'Review' },
          ],
        }),
        cowork: () => ({ sessions: [{ id: 'idle-source', status: 'idle' }] }),
      },
    });
    render(
      <Provider store={store}>
        <CollaborationPanel
          source={{ id: 'idle-source', agentId: 'main', status: 'idle' } as CoworkSession}
          selectedMemberId={selectedMemberId}
          onSelect={vi.fn()}
        />
      </Provider>,
    );
    return stop;
  };

  it('offers whole-team Stop in the flow header even when the organizer is idle', async () => {
    const stop = mount();
    const button = await screen.findByRole('button', { name: i18nService.t('collaborationStop') });
    expect(button.closest('div')?.parentElement?.textContent).toContain(
      i18nService.t('collaborationOverview'),
    );
    fireEvent.click(button);
    await act(async () => {});
    expect(stop).toHaveBeenCalledWith('idle-source');
    // The acknowledgement cannot turn the execution badge into a completed result.
    expect(screen.getByRole('status').textContent).toContain(i18nService.t('teamRound_open'));
  });

  it('binds the member detail Stop scope to the exact collaboration room', async () => {
    const stop = mount('working-peer');
    const history = await screen.findByText('History: Review');
    expect(history.getAttribute('data-room-id')).toBe('stop-room');
    expect(stop).not.toHaveBeenCalled();
  });
});
describe('collaboration team roster', () => {
  it('keeps all three nodes and their layout while batch deliveries arrive and settle', async () => {
    const members = [
      { agentId: 'main', sessionId: 'source', sessionKey: 'agent:main:justdo:source' },
      {
        agentId: 'research',
        sessionId: 'research-session',
        sessionKey: 'agent:research:justdo:research-session',
      },
      {
        agentId: 'review',
        sessionId: 'review-session',
        sessionKey: 'agent:review:justdo:review-session',
      },
    ];
    let snapshot: CollaborationSnapshot = {
      room: { id: 'roster-room', anchorSessionId: 'source', members },
      deliveries: [],
      rounds: [{ id: 'batch', state: 'open', pending: 0 }],
    };
    let refresh!: () => void;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: {
          read: vi.fn(async () => ({ success: true, value: snapshot })),
          list: vi.fn(async () => ({
            success: true,
            value: [{ ...snapshot.room!, rounds: snapshot.rounds }],
          })),
        },
        cowork: {
          onSessionsChanged: (listener: () => void) => {
            refresh = listener;
            return vi.fn();
          },
        },
      },
    });
    const store = configureStore({
      reducer: {
        agent: () => ({
          agents: members.map(member => ({ id: member.agentId, name: member.agentId })),
        }),
        cowork: () => ({
          sessions: members.map(member => ({ id: member.sessionId, status: 'running' })),
        }),
      },
    });
    const props = { source: { id: 'source', agentId: 'main' } as CoworkSession, onSelect: vi.fn() };
    const { rerender } = render(
      <Provider store={store}>
        <CollaborationPanel {...props} />
      </Provider>,
    );
    await screen.findByRole('button', { name: 'review' });
    await act(async () => {});
    const layout = () =>
      members.map(member => {
        const circle = screen
          .getByRole('button', { name: member.agentId })
          .querySelector('circle')!;
        return ['cx', 'cy', 'r', 'stroke', 'class'].map(attribute =>
          circle.getAttribute(attribute),
        );
      });
    const initialLayout = layout();
    rerender(
      <Provider store={store}>
        <CollaborationPanel {...props} roundId="batch" />
      </Provider>,
    );
    expect(layout()).toEqual(initialLayout);
    expect(screen.queryByText(i18nService.t('coworkStatusRunning'))).toBeNull();
    const delivery = {
      id: 'research-receipt',
      roomId: 'roster-room',
      roundId: 'batch',
      from: 'main',
      to: 'research',
      toolCallId: 'research-call',
      sourceRunId: 'source-run',
      state: 'queued' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    for (const state of ['queued', 'accepted'] as const) {
      snapshot = {
        ...snapshot,
        deliveries: [
          { ...delivery, state, ...(state === 'accepted' ? { runId: 'research-run' } : {}) },
        ],
      };
      await act(async () => refresh());
      expect(
        within(screen.getByRole('button', { name: 'research' })).getByText(
          i18nService.t(state === 'queued' ? 'collaborationQueued' : 'collaborationAccepted'),
        ),
      ).toBeTruthy();
      expect(layout()).toEqual(initialLayout);
      expect(
        within(screen.getByRole('button', { name: 'review' })).queryByText(
          i18nService.t('collaborationAccepted'),
        ),
      ).toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    expect(props.onSelect).toHaveBeenCalledWith('review-session');
    snapshot = {
      ...snapshot,
      deliveries: [
        { ...delivery, state: 'accepted', runId: 'research-run', executionOutcome: 'completed' },
        {
          ...delivery,
          id: 'review-receipt',
          from: 'research',
          to: 'review',
          state: 'accepted',
          runId: 'review-run',
          createdAt: 2,
        },
      ],
    };
    await act(async () => refresh());
    expect(layout()).toEqual(initialLayout);
    expect(
      within(screen.getByRole('button', { name: 'research' })).getByText(
        i18nService.t('teamExecution_completed'),
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'review' })).getByText(
        i18nService.t('collaborationAccepted'),
      ),
    ).toBeTruthy();
    rerender(
      <Provider store={store}>
        <CollaborationPanel {...props} roundId="batch" selectedMemberId="review-session" />
      </Provider>,
    );
    expect(await screen.findByText('History: review')).toBeTruthy();
  });
});

describe('scoped independent review display', () => {
  it('keeps the roster while isolating historical batch edges, statuses and reviews from newer collaboration', async () => {
    const members = [
      { agentId: 'main', sessionId: 'source', sessionKey: 'agent:main:justdo:source' },
      {
        agentId: 'older',
        sessionId: 'older-session',
        sessionKey: 'agent:older:justdo:older-session',
      },
      {
        agentId: 'newer',
        sessionId: 'newer-session',
        sessionKey: 'agent:newer:justdo:newer-session',
      },
    ];
    const deliveries = ['older', 'newer'].map((agentId, index) => ({
      id: `${agentId}-receipt`,
      roomId: 'room',
      roundId: `${agentId}-batch`,
      from: 'main',
      to: agentId,
      toolCallId: `${agentId}-call`,
      sourceRunId: 'source-run',
      runId: `${agentId}-run`,
      state: 'accepted' as const,
      createdAt: index,
      updatedAt: index,
    }));
    const reviews: CollaborationReview[] = ['older', 'newer'].map(agentId => ({
      id: `${agentId}-report`,
      roomId: 'room',
      roundId: `${agentId}-batch`,
      reviewerAgentId: agentId,
      reviewDeliveryId: `${agentId}-receipt`,
      runId: `${agentId}-run`,
      createdAt: 1,
      deliveryIds: [`${agentId}-work`],
      verdict: 'passed',
      state: 'confirmed',
    }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: {
          read: vi.fn().mockResolvedValue({
            success: true,
            value: {
              room: { id: 'room', anchorSessionId: 'source', members },
              deliveries,
              reviews,
              rounds: [
                { id: 'older-batch', state: 'settled', pending: 0 },
                { id: 'newer-batch', state: 'open', pending: 1 },
              ],
            },
          }),
          readMessages: vi.fn().mockResolvedValue({ success: true, value: [] }),
        },
      },
    });
    const store = configureStore({
      reducer: {
        agent: () => ({
          agents: members.map(member => ({
            id: member.agentId,
            name: member.agentId,
            enabled: true,
          })),
        }),
        cowork: () => ({
          sessions: members.map(member => ({ id: member.sessionId, status: 'running' })),
        }),
      },
    });
    const onSelect = vi.fn();
    const props = {
      source: { id: 'source', agentId: 'main' } as CoworkSession,
      roomId: 'room',
      roundId: 'older-batch',
      selectedMemberId: 'not-in-team',
      onSelect,
    };
    const { rerender } = render(
      <Provider store={store}>
        <CollaborationPanel {...props} />
      </Provider>,
    );
    const report = await screen.findByRole('button', {
      name: new RegExp(`${i18nService.t('teamIndependentReview')} · older`),
    });
    const newerNode = screen.getByRole('button', { name: 'newer' });
    expect(within(newerNode).queryByText(i18nService.t('collaborationAccepted'))).toBeNull();
    expect(screen.queryByRole('button', { name: /main → newer/ })).toBeNull();
    expect(screen.queryByText(i18nService.t('coworkStatusRunning'))).toBeNull();
    expect(screen.queryByText('History: newer')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: new RegExp(`${i18nService.t('teamIndependentReview')} · newer`),
      }),
    ).toBeNull();
    fireEvent.click(report);
    const history = await screen.findByText('History: older');
    expect(history.getAttribute('data-delivery-id')).toBe('older-receipt');
    expect(history.getAttribute('data-run-id')).toBe('older-run');
    rerender(
      <Provider store={store}>
        <CollaborationPanel {...props} roundId="newer-batch" selectedMemberId={undefined} />
      </Provider>,
    );
    expect(
      await screen.findByRole('button', {
        name: new RegExp(`${i18nService.t('teamIndependentReview')} · newer`),
      }),
    ).toBeTruthy();
    expect(screen.queryByText('History: older')).toBeNull();
    expect(screen.getByRole('button', { name: 'older' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'newer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /main → older/ })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: new RegExp(`${i18nService.t('teamIndependentReview')} · older`),
      }),
    ).toBeNull();
  });
  it.each(['pending', 'unconfirmed', 'failed', 'cancelled', 'confirmed'] as const)(
    'shows %s reports honestly and opens only the exact reviewer execution',
    async state => {
      const review: CollaborationReview = {
        id: 'report',
        roomId: 'room',
        roundId: 'batch',
        reviewerAgentId: 'review',
        reviewDeliveryId: 'review-receipt',
        runId: 'review-run',
        createdAt: 1,
        deliveryIds: ['work-receipt'],
        verdict: 'passed',
        state,
      };
      const snapshot: CollaborationSnapshot = {
        room: {
          id: 'room',
          anchorSessionId: 'source',
          members: [
            { agentId: 'main', sessionId: 'source', sessionKey: 'agent:main:justdo:source' },
            {
              agentId: 'review',
              sessionId: 'review-session',
              sessionKey: 'agent:review:justdo:review-session',
            },
          ],
        },
        rounds: [{ id: 'batch', state: 'open', pending: state === 'pending' ? 1 : 0 }],
        reviews: [
          review,
          { ...review, id: 'old-report', reviewerAgentId: 'Old reviewer', roundId: 'old-batch' },
        ],
        deliveries: [
          {
            id: 'review-receipt',
            roomId: 'room',
            roundId: 'batch',
            from: 'main',
            to: 'review',
            toolCallId: 'call',
            sourceRunId: 'source-run',
            runId: 'review-run',
            state: 'accepted',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      };
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          collaboration: { read: vi.fn().mockResolvedValue({ success: true, value: snapshot }) },
        },
      });
      const store = configureStore({
        reducer: {
          agent: () => ({
            agents: [
              { id: 'main', name: 'Main', enabled: true },
              { id: 'review', name: 'Review', enabled: true },
            ],
          }),
        },
      });
      const select = vi.fn();
      render(
        <Provider store={store}>
          <CollaborationPanel
            source={{ id: 'source', agentId: 'main' } as CoworkSession}
            onSelect={select}
          />
        </Provider>,
      );
      const status = i18nService.t(
        state === 'confirmed' ? 'teamReviewVerdict_passed' : `teamReviewState_${state}`,
      );
      const label = `${i18nService.t('teamIndependentReview')} · Review · ${status} · ${i18nService.t('teamReviewedExecutions')}: 1`;
      const report = await screen.findByRole('button', { name: label });
      expect(screen.queryByText(/Old reviewer/)).toBeNull();
      if (state !== 'confirmed')
        expect(report.textContent).not.toContain(i18nService.t('teamReviewVerdict_passed'));
      fireEvent.click(report);
      const history = await screen.findByText('History: Review');
      expect(history.getAttribute('data-run-id')).toBe('review-run');
      expect(history.getAttribute('data-delivery-id')).toBe('review-receipt');
      expect(select).toHaveBeenCalledWith(undefined);
    },
  );
});
describe('collaboration member setup', () => {
  it('shows model-driven guidance without manual setup and opens participating agents', async () => {
    const room = {
      id: 'room',
      anchorSessionId: 'source',
      members: [
        { agentId: 'main', sessionId: 'source', sessionKey: 'agent:main:justdo:source' },
        {
          agentId: 'review',
          sessionId: 'review-session',
          sessionKey: 'agent:review:justdo:review-session',
        },
      ],
    };
    const create = vi.fn().mockResolvedValue({ success: true, value: { room, deliveries: [] } });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: {
          read: vi.fn().mockResolvedValue({ success: true, value: { room, deliveries: [] } }),
          create,
        },
      },
    });
    const store = configureStore({
      reducer: {
        agent: () => ({
          agents: [
            { id: 'main', name: 'Main', enabled: true },
            { id: 'review', name: 'Review', enabled: true },
          ],
        }),
      },
    });
    const select = vi.fn();
    const { rerender } = render(
      <Provider store={store}>
        <CollaborationPanel
          source={{ id: 'source', agentId: 'main' } as CoworkSession}
          onSelect={select}
        />
      </Provider>,
    );
    await screen.findByRole('button', { name: 'Review' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(select).toHaveBeenCalledWith('review-session');
    rerender(
      <Provider store={store}>
        <CollaborationPanel
          source={{ id: 'source', agentId: 'main' } as CoworkSession}
          selectedMemberId="review-session"
          onSelect={select}
        />
      </Provider>,
    );
    expect(await screen.findByText('History: Review')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: i18nService.t('collaborationBackToOverview') }),
    );
    expect(select).toHaveBeenLastCalledWith(undefined);
  });
});

describe('collaboration room refresh', () => {
  it.each(['rejected', 'unsuccessful', 'late failure'])(
    'recovers automatic opening after a %s initial query',
    async failure => {
      const makeRoom = (id: string) => ({ id, anchorSessionId: id, members: [] });
      let rooms = [makeRoom('historic')];
      let refresh!: () => void;
      let rejectInitial!: (error: Error) => void;
      const list = vi.fn(async () => ({ success: true, value: rooms }));
      if (failure === 'rejected') list.mockRejectedValueOnce(new Error('not ready'));
      else if (failure === 'unsuccessful')
        list.mockResolvedValueOnce({ success: false, value: [] });
      else
        list.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectInitial = reject;
            }),
        );
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          collaboration: { list },
          cowork: {
            onSessionsChanged: (listener: () => void) => {
              refresh = listener;
              return vi.fn();
            },
          },
        },
      });
      const open = vi.fn();
      renderHook(() =>
        useCollaborationRooms({ activeSessionId: 'foreground', onFirstCollaboration: open }),
      );
      await act(async () => {});
      await act(async () => refresh());
      if (failure === 'late failure') await act(async () => rejectInitial(new Error('not ready')));
      expect(open).not.toHaveBeenCalled();
      rooms = [...rooms, makeRoom('foreground')];
      await act(async () => refresh());
      expect(open).toHaveBeenCalledExactlyOnceWith('foreground');
    },
  );

  it('shares one room query and one native listener across all consumers', async () => {
    const unsubscribe = vi.fn();
    const list = vi.fn(async () => ({ success: true as const, value: [] }));
    const onSessionsChanged = vi.fn(() => unsubscribe);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { collaboration: { list }, cowork: { onSessionsChanged } },
    });

    const first = renderHook(useCollaborationRooms);
    const second = renderHook(useCollaborationRooms);
    await act(async () => {});
    expect(list).toHaveBeenCalledOnce();
    expect(onSessionsChanged).toHaveBeenCalledOnce();
    first.unmount();
    expect(unsubscribe).not.toHaveBeenCalled();
    second.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not reopen an already observed room when a foreground consumer remounts', async () => {
    const makeRoom = (id: string) => ({ id, anchorSessionId: id, members: [] });
    let rooms = [makeRoom('historic')];
    let refresh!: () => void;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: { list: vi.fn(async () => ({ success: true, value: rooms })) },
        cowork: {
          onSessionsChanged: (listener: () => void) => {
            refresh = listener;
            return vi.fn();
          },
        },
      },
    });
    const keeper = renderHook(useCollaborationRooms);
    await act(async () => {});
    rooms = [...rooms, makeRoom('existing')];
    await act(async () => refresh());

    const open = vi.fn();
    const foreground = renderHook(() =>
      useCollaborationRooms({ activeSessionId: 'existing', onFirstCollaboration: open }),
    );
    await act(async () => {});
    expect(open).not.toHaveBeenCalled();
    foreground.unmount();
    keeper.unmount();
  });

  it('opens only newly observed foreground collaboration, never initial or background rooms', async () => {
    const makeRoom = (id: string) => ({ id, anchorSessionId: id, members: [] });
    let rooms = [makeRoom('historic')];
    let refresh!: () => void;
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: { list: vi.fn(async () => ({ success: true, value: rooms })) },
        cowork: {
          onSessionsChanged: (listener: () => void) => {
            refresh = listener;
            return vi.fn();
          },
        },
      },
    });
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useCollaborationRooms({ activeSessionId: id, onFirstCollaboration: open }),
      { initialProps: { id: 'historic' } },
    );
    await act(async () => {});
    expect(open).not.toHaveBeenCalled();
    rerender({ id: 'foreground' });
    rooms = [...rooms, makeRoom('foreground'), makeRoom('background')];
    await act(async () => refresh());
    expect(open).toHaveBeenCalledExactlyOnceWith('foreground');
    // Dismissing the panel has no effect on observation: subsequent refresh cannot reopen it.
    await act(async () => refresh());
    rerender({ id: 'background' });
    await act(async () => refresh());
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('does not open a room when the user switches sessions during refresh', async () => {
    let refresh!: () => void;
    let resolve!: (value: unknown) => void;
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: true, value: [] })
      .mockImplementation(
        () =>
          new Promise(done => {
            resolve = done;
          }),
      );
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: { list },
        cowork: {
          onSessionsChanged: (listener: () => void) => {
            refresh = listener;
            return vi.fn();
          },
        },
      },
    });
    const open = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useCollaborationRooms({ activeSessionId: id, onFirstCollaboration: open }),
      { initialProps: { id: 'a' } },
    );
    await act(async () => {});
    act(() => refresh());
    rerender({ id: 'b' });
    await act(async () =>
      resolve({ success: true, value: [{ id: 'room', anchorSessionId: 'a', members: [] }] }),
    );
    expect(open).not.toHaveBeenCalled();
  });
  it('keeps newly joined members when an older room snapshot finishes last', async () => {
    const room = {
      id: 'room',
      anchorSessionId: 'source',
      members: [
        { agentId: 'main', sessionId: 'source', sessionKey: 'agent:main:justdo:source' },
        { agentId: 'review', sessionId: 'peer', sessionKey: 'agent:review:justdo:peer' },
      ],
    };
    type RoomResult = { success: true; value: (typeof room)[] };
    let resolveOld!: (value: RoomResult) => void;
    let resolveLatest!: (value: RoomResult) => void;
    const oldRequest = new Promise<RoomResult>(resolve => {
      resolveOld = resolve;
    });
    const latestRequest = new Promise<RoomResult>(resolve => {
      resolveLatest = resolve;
    });
    let sessionsChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const list = vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(latestRequest);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: { list },
        cowork: {
          onSessionsChanged: (listener: () => void) => {
            sessionsChanged = listener;
            return unsubscribe;
          },
        },
      },
    });
    const { result, unmount } = renderHook(useCollaborationRooms);
    act(() => sessionsChanged?.());
    await act(async () => resolveLatest({ success: true, value: [room] }));
    expect(result.current).toEqual([room]);
    await act(async () => resolveOld({ success: true, value: [] }));
    expect(result.current).toEqual([room]);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('persistent collaboration graph entry', () => {
  it('opens an existing collaboration and remains available after closing its panel', async () => {
    const room = {
      id: 'existing-room',
      anchorSessionId: 'main-session',
      members: [
        { agentId: 'main', sessionId: 'main-session' },
        { agentId: 'review', sessionId: 'review-session' },
      ],
    };
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: { list: vi.fn().mockResolvedValue({ success: true, value: [room] }) },
      },
    });
    const open = vi.fn();
    const { rerender } = render(
      <CollaborationMemberLinks sessionId="main-session" onOpen={open} />,
    );
    const button = await screen.findByRole('button', {
      name: i18nService.t('teamTitle'),
    });
    expect(button.textContent).toContain('1');
    fireEvent.click(button);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(i18nService.t('teamTask')) }));
    rerender(<CollaborationMemberLinks sessionId="main-session" onOpen={open} />);
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('teamTitle') }));
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(i18nService.t('teamTask')) }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'task:existing-room', roomId: 'existing-room' }),
    );
    rerender(<CollaborationMemberLinks sessionId="unrelated-session" onOpen={open} />);
    // An unrelated chat still exposes global records without inventing a local team.
    expect(screen.getByRole('button', { name: i18nService.t('teamTitle') })).toBeTruthy();
    rerender(<CollaborationMemberLinks sessionId="main-session" onOpen={open} />);
    expect(screen.getByRole('button', { name: i18nService.t('teamTitle') })).toBeTruthy();
  });

  it('recognizes the anchor even if a room snapshot only contains its peers', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        collaboration: {
          list: vi.fn().mockResolvedValue({
            success: true,
            value: [
              {
                id: 'room',
                anchorSessionId: 'main-session',
                members: [{ agentId: 'review', sessionId: 'review-session' }],
              },
            ],
          }),
        },
      },
    });
    render(<CollaborationMemberLinks sessionId="main-session" onOpen={vi.fn()} />);
    expect(await screen.findByRole('button', { name: i18nService.t('teamTitle') })).toBeTruthy();
  });
});
