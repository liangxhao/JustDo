// @vitest-environment jsdom
import type {
  AppBrowserContribution,
  AppBrowserHost,
  AppSessionPresentation,
} from '@app-plugin/sdk/browser';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { CollaborationRoom } from '../../contracts/collaboration';
import type { TeamDiscussionRoom } from '../../contracts/teamDiscussion';

const fixture = vi.hoisted(() => ({
  rooms: [] as CollaborationRoom[],
  discussions: [] as TeamDiscussionRoom[],
  roomsReady: true,
  discussionsReady: true,
  collaboration: undefined as
    { activeSessionId: string | null; onFirstCollaboration(id: string): void } | undefined,
  created: undefined as ((room: TeamDiscussionRoom) => void) | undefined,
  metadata: {
    cowork: { currentSession: { id: 'source' }, sessions: [], sessionRuntimeActivity: {} },
  },
  host: undefined as AppBrowserHost | undefined,
}));
vi.mock('./collaboration/CollaborationPanel', () => ({
  useCollaborationRooms: () => fixture.rooms,
  useCollaborationRoomsState: (options: typeof fixture.collaboration) => {
    fixture.collaboration = options;
    return { rooms: fixture.rooms, ready: fixture.roomsReady };
  },
}));
vi.mock('./discussions/teamDiscussionNavigation', () => ({
  useTeamDiscussionRoomsState: (created: typeof fixture.created) => {
    fixture.created = created;
    return { rooms: fixture.discussions, ready: fixture.discussionsReady };
  },
}));
vi.mock('./sessions/CollaborationTaskDetails', () => ({
  default: ({
    onSelect,
  }: {
    onSelect(summary: import('@app-plugin/sdk/application').CoworkSessionSummary): void;
  }) => (
    <button
      onClick={() =>
        onSelect({
          id: 'member',
          title: 'Member',
          status: 'completed',
          pinned: false,
          createdAt: 1,
          updatedAt: 2,
        })
      }
    >
      Inspect member
    </button>
  ),
}));
vi.mock('./ports', () => ({
  bindBrowserHost: () => () => undefined,
  browserHost: () => fixture.host!,
  application: { metadata: { getSnapshot: () => fixture.metadata } },
}));

import {
  registerSessionPresentation,
  teamDetailsPresentation,
  TeamSessionDetails,
} from './sessionPresentation';

let release: (() => void) | undefined;
afterEach(() => {
  cleanup();
  release?.();
  fixture.rooms = [];
  fixture.discussions = [];
  fixture.roomsReady = true;
  fixture.discussionsReady = true;
  fixture.metadata = {
    cowork: { currentSession: { id: 'source' }, sessions: [], sessionRuntimeActivity: {} },
  };
});
function mount() {
  const controller = new AbortController();
  const views: AppBrowserContribution[] = [];
  let presentation!: (id: string) => AppSessionPresentation | undefined;
  const open = vi.fn();
  const publish = vi.fn();
  const host = {
    signal: controller.signal,
    application: {
      metadata: { getSnapshot: () => fixture.metadata, subscribe: () => () => undefined },
    },
    openWorkspace: open,
    interactionContextChanged: vi.fn(),
    publishSessionActivity: publish,
    registerView: (view: AppBrowserContribution) => views.push(view),
    registerSessionPresentation: (resolve: typeof presentation) => {
      presentation = resolve;
      return () => undefined;
    },
    t: (key: string) => key,
  } as unknown as AppBrowserHost;
  fixture.host = host;
  release = registerSessionPresentation(host);
  const Observer = views.find(view => view.id === 'session-observer')!.component;
  const view = render(<Observer />);
  return { controller, open, presentation, publish, view, Observer };
}

test('opens first-discovery Team tabs only for the exact current chat and active lifetime', () => {
  const { controller, open } = mount();
  expect(fixture.collaboration?.activeSessionId).toBe('source');
  act(() => fixture.collaboration!.onFirstCollaboration('source'));
  expect(open).toHaveBeenLastCalledWith('team', 'source', undefined);
  act(() => fixture.created!({ id: 'group', sourceSessionId: 'source' } as TeamDiscussionRoom));
  expect(open).toHaveBeenLastCalledWith('team', 'source', {
    key: 'group:group',
    version: expect.any(Number),
  });
  const accepted = open.mock.calls.length;
  act(() => fixture.created!({ id: 'background', sourceSessionId: 'other' } as TeamDiscussionRoom));
  fixture.metadata = {
    ...fixture.metadata,
    cowork: { ...fixture.metadata.cowork, currentSession: { id: 'other' } },
  };
  act(() => fixture.collaboration!.onFirstCollaboration('source'));
  controller.abort();
  act(() => fixture.collaboration!.onFirstCollaboration('other'));
  expect(open).toHaveBeenCalledTimes(accepted);
});

test('publishes collaboration and discussion summary availability without mounting summary UI', () => {
  fixture.rooms = [
    { id: 'task', anchorSessionId: 'task-source', members: [] } as unknown as CollaborationRoom,
  ];
  fixture.discussions = [{ id: 'group', sourceSessionId: 'group-source' } as TeamDiscussionRoom];
  const { presentation, view } = mount();
  expect(presentation('task-source')?.summaryAvailable).toBe(true);
  expect(presentation('group-source')).toEqual({ summaryAvailable: true });
  expect(presentation('unrelated')).toBeUndefined();
  fixture.rooms = [];
  fixture.discussions = [];
  view.rerender(<></>);
  release?.();
  expect(presentation('task-source')).toBeUndefined();
  expect(presentation('group-source')).toBeUndefined();
});

test('only replaces collaboration anchors and delegates member inspection without chat navigation', () => {
  fixture.rooms = [
    {
      id: 'task',
      anchorSessionId: 'source',
      members: [{ sessionId: 'member' }],
    } as unknown as CollaborationRoom,
  ];
  const { open } = mount();
  expect(teamDetailsPresentation('source')).toBe('replace');
  expect(teamDetailsPresentation('member')).toBe('hidden');
  expect(teamDetailsPresentation('other')).toBe('hidden');
  const inspect = vi.fn();
  render(
    <TeamSessionDetails
      sessionSummary={{
        id: 'source',
        title: 'Source',
        status: 'completed',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      }}
      onInspectSession={inspect}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect member' }));
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ id: 'member' }));
  expect(open).not.toHaveBeenCalled();
  release?.();
  expect(teamDetailsPresentation('source')).toBe('hidden');
});

test('publishes current native member activity rather than historical member status', () => {
  fixture.rooms = [
    {
      id: 'task',
      anchorSessionId: 'source',
      members: [{ agentId: 'worker', sessionId: 'peer', status: 'running' }],
    } as unknown as CollaborationRoom,
  ];
  const { presentation, publish, view, Observer } = mount();
  expect(presentation('source')?.summaryAvailable).toBe(true);
  expect(publish).toHaveBeenLastCalledWith([]);
  fixture.metadata.cowork.sessionRuntimeActivity = { peer: true };
  view.rerender(<Observer />);
  expect(publish).toHaveBeenLastCalledWith(['source']);
  fixture.metadata.cowork.sessionRuntimeActivity = { peer: false };
  view.rerender(<Observer />);
  expect(publish).toHaveBeenLastCalledWith([]);
});

test('waits for both complete lists and keeps activity across failed reads and retirement', () => {
  fixture.roomsReady = false;
  fixture.discussionsReady = false;
  const { controller, publish, view, Observer } = mount();
  expect(publish).not.toHaveBeenCalled();
  fixture.roomsReady = true;
  view.rerender(<Observer />);
  expect(publish).not.toHaveBeenCalled();
  fixture.discussions = [
    { id: 'group', sourceSessionId: 'source', state: 'running' } as TeamDiscussionRoom,
  ];
  fixture.discussionsReady = true;
  view.rerender(<Observer />);
  expect(publish).toHaveBeenLastCalledWith(['source']);
  const confirmed = publish.mock.calls.length;
  fixture.roomsReady = false;
  fixture.discussionsReady = false;
  fixture.discussions = [];
  view.rerender(<Observer />);
  expect(publish).toHaveBeenCalledTimes(confirmed);
  fixture.roomsReady = true;
  view.rerender(<Observer />);
  expect(publish).toHaveBeenCalledTimes(confirmed);
  fixture.discussionsReady = true;
  view.rerender(<Observer />);
  expect(publish).toHaveBeenLastCalledWith([]);
  controller.abort();
  const beforeRetire = publish.mock.calls.length;
  view.unmount();
  release?.();
  expect(publish).toHaveBeenCalledTimes(beforeRetire);
});
