// @vitest-environment jsdom
import type { CollaborationRoomEntry } from '@shared/cowork/agent-team/collaboration';
import type { TeamDiscussionRoom } from '@shared/cowork/agent-team/teamDiscussion';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CoworkSession } from '@/features/cowork/coworkTypes';

import AgentTeamPanel from './AgentTeamPanel';

const fixtures = vi.hoisted(() => ({
  groups: [] as Pick<
    TeamDiscussionRoom,
    'id' | 'title' | 'sourceSessionId' | 'members' | 'state'
  >[],
  collaborations: [] as CollaborationRoomEntry[],
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('../../discussions/teamDiscussionNavigation', () => ({
  useTeamDiscussionRooms: () => fixtures.groups,
}));
vi.mock('../../collaboration/CollaborationPanel', () => ({
  default: ({ roomId, roundId }: { roomId: string; roundId?: string }) => (
    <div>
      Task graph: {roomId}/{roundId ?? 'prepared'}
    </div>
  ),
  useCollaborationRooms: () => fixtures.collaborations,
}));
vi.mock('../../discussions/TeamDiscussionView', () => ({
  default: ({ entry }: { entry: { roomId: string } }) => <div>Group input: {entry.roomId}</div>,
}));
beforeEach(() => {
  fixtures.groups = [
    {
      id: 'discussion',
      title: 'Design review',
      sourceSessionId: 'source',
      members: [],
      state: 'ready',
    },
    {
      id: 'other-discussion',
      title: 'Unrelated project',
      sourceSessionId: 'other',
      members: [],
      state: 'ready',
    },
  ];
  fixtures.collaborations = [
    {
      id: 'task-room',
      anchorSessionId: 'source',
      members: [],
      rounds: [{ id: 'batch', state: 'open', pending: 0 }],
    },
  ];
});
afterEach(cleanup);

const source = { id: 'source' } as CoworkSession;

it('keeps linked group chat and the collaboration graph in one task panel', () => {
  render(<AgentTeamPanel source={source} discussionId="discussion" onSelect={vi.fn()} />);
  expect(screen.getByText('Group input: discussion')).toBeTruthy();
  expect(screen.queryByText(/Unrelated project/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'teamTask · 1' }));
  expect(screen.getByText('Task graph: task-room/batch')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup · Design review' }));
  expect(screen.getByText('Group input: discussion')).toBeTruthy();
});

it('shows only linked groups when the conversation has no collaboration', () => {
  fixtures.collaborations = [];
  render(<AgentTeamPanel source={source} onSelect={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'teamGroup · Design review' })).toBeTruthy();
  expect(screen.queryByText(/Task graph/)).toBeNull();
  expect(screen.queryByText('teamTask')).toBeNull();
});

it('shows two real collaboration batches and three linked groups as five independent tabs', () => {
  fixtures.collaborations[0].rounds.push({ id: 'second-batch', state: 'settled', pending: 0 });
  fixtures.groups.push(
    {
      id: 'second-group',
      title: 'Architecture',
      sourceSessionId: 'source',
      members: [],
      state: 'ready',
    },
    { id: 'third-group', title: 'Risks', sourceSessionId: 'source', members: [], state: 'ready' },
  );
  const onSelect = vi.fn();
  render(<AgentTeamPanel source={source} onSelect={onSelect} />);
  expect(screen.getAllByRole('button')).toHaveLength(5);
  expect(screen.getByText('Task graph: task-room/second-batch')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'teamTask · 1' }));
  expect(screen.getByText('Task graph: task-room/batch')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup · Risks' }));
  expect(screen.getByText('Group input: third-group')).toBeTruthy();
  expect(onSelect).toHaveBeenCalledWith(undefined);
  expect(screen.queryByText(/Unrelated project/)).toBeNull();
});

it('omits group placeholders for a conversation with only collaboration', () => {
  fixtures.groups = [];
  render(<AgentTeamPanel source={source} onSelect={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByText(/teamGroup/)).toBeNull();
  expect(screen.queryByText('teamGroupEmpty')).toBeNull();
});

it('shows no tab or graph when the conversation has no team', () => {
  fixtures.groups = [];
  fixtures.collaborations = [];
  render(<AgentTeamPanel source={source} onSelect={vi.fn()} />);
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('teamNoTeams')).toBeTruthy();
  expect(screen.queryByText(/Task graph|Group input/)).toBeNull();
});

it('retains an existing prepared team without manufacturing a batch', () => {
  fixtures.groups = [];
  fixtures.collaborations[0].rounds = [];
  render(<AgentTeamPanel source={source} onSelect={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'teamTask' })).toBeTruthy();
  expect(screen.getByText('Task graph: task-room/prepared')).toBeTruthy();
});

it('falls back to an existing tab when a selected group is deleted', () => {
  const props = { source, discussionId: 'discussion', onSelect: vi.fn() };
  const { rerender } = render(<AgentTeamPanel {...props} />);
  expect(screen.getByText('Group input: discussion')).toBeTruthy();
  fixtures.groups = [];
  rerender(<AgentTeamPanel {...props} />);
  expect(screen.getByText('Task graph: task-room/batch')).toBeTruthy();
  expect(screen.queryByText(/Group input/)).toBeNull();
});

it('isolates navigation when the source conversation changes', () => {
  const props = { source, discussionId: 'discussion', onSelect: vi.fn() };
  const { rerender } = render(<AgentTeamPanel {...props} />);
  rerender(<AgentTeamPanel {...props} source={{ id: 'other' } as CoworkSession} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByText('Group input: other-discussion')).toBeTruthy();
  expect(screen.queryByText(/Task graph|Design review/)).toBeNull();
});

it('opens an exact historical collaboration selected from the header and accepts a repeated selection', () => {
  fixtures.collaborations[0].rounds.push({ id: 'newer-batch', state: 'open', pending: 0 });
  const props = { source, onSelect: vi.fn() };
  const { rerender } = render(
    <AgentTeamPanel {...props} selectionRequest={{ key: 'task:task-room:batch', version: 1 }} />,
  );
  expect(screen.getByText('Task graph: task-room/batch')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup · Design review' }));
  expect(screen.getByText('Group input: discussion')).toBeTruthy();
  rerender(
    <AgentTeamPanel {...props} selectionRequest={{ key: 'task:task-room:batch', version: 2 }} />,
  );
  expect(screen.getByText('Task graph: task-room/batch')).toBeTruthy();
});

it('opens the latest collaboration on a fresh summary request after a manual tab selection', () => {
  fixtures.collaborations[0].rounds.push({ id: 'newer-batch', state: 'open', pending: 0 });
  const props = { source, onSelect: vi.fn() };
  const { rerender } = render(<AgentTeamPanel {...props} selectionRequest={{ version: 1 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'teamGroup · Design review' }));
  expect(screen.getByText('Group input: discussion')).toBeTruthy();
  rerender(<AgentTeamPanel {...props} selectionRequest={{ version: 2 }} />);
  expect(screen.getByText('Task graph: task-room/newer-batch')).toBeTruthy();
});
