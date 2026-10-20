// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ openWorkspace: vi.fn() }));
vi.mock('./ports', () => ({
  browserHost: () => ({
    openWorkspace: fixture.openWorkspace,
    t: (key: string) =>
      (
        ({
          teamTitle: 'Agent Team',
          teamSummaryTaskCount: 'Tasks {count}',
          teamSummaryGroupCount: 'Groups {count}',
          teamSummaryCountSeparator: ' · ',
        }) as Record<string, string>
      )[key] ?? key,
  }),
  application: {},
  teamApi: {},
}));
vi.mock('./state', () => ({ useSelector: () => undefined }));
vi.mock('./display/AgentTeamPanel', () => ({ default: () => null }));
vi.mock('./collaboration/collaborationContinueSubmission', () => ({
  submitCollaborationContinuation: vi.fn(),
}));
vi.mock('./collaboration/CollaborationPanel', () => ({
  useCollaborationRooms: () => [{ id: 'task', anchorSessionId: 'source', members: [] }],
}));
vi.mock('./discussions/teamDiscussionNavigation', () => ({
  useTeamDiscussionRooms: () => [
    {
      id: 'group',
      sourceSessionId: 'source',
      title: 'Group',
      members: [],
      state: 'ready',
    },
  ],
}));

import { TeamSummary } from './workspace';

afterEach(cleanup);

test('retains the summary row focus treatment and compact right-aligned Team counts', () => {
  const close = vi.fn();
  render(
    <TeamSummary
      session={{
        id: 'source',
        title: 'Source',
        cwd: '',
        agentId: 'main',
        status: 'idle',
      }}
      onClose={close}
    />,
  );
  const row = screen.getByRole('button', { name: 'Agent Team Tasks 1 · Groups 1' });
  expect(row.className).toContain('session-summary-panel__action');
  expect(row.className).toContain('focus-visible:ring-2');
  const count = screen.getByText('Tasks 1 · Groups 1');
  expect(count.className).toContain('text-right');
  expect(count.className).toContain('text-xs');
  expect(count.className).toContain('tabular-nums');
  fireEvent.click(row);
  expect(close).toHaveBeenCalledOnce();
  expect(fixture.openWorkspace).toHaveBeenCalledExactlyOnceWith('team', 'source');
});
