// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';

import { OPEN_TEAM_PANEL, openTeamPanel } from '../discussions/teamDiscussionNavigation';
import { AgentTeamKind } from './agentTeamEntries';
import { type AgentTeamHistoryEntry, openTeamHistoryEntry } from './agentTeamHistory';

const state = vi.hoisted(() => ({ cowork: { currentSession: { id: 'source' } } }));
vi.mock('@/store', () => ({ store: { getState: () => state } }));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: { loadSession: vi.fn() } }));
vi.mock('../discussions/teamDiscussionNavigation', () => ({
  OPEN_TEAM_PANEL: 'cowork:open-team-panel',
  openTeamPanel: vi.fn(),
}));
const task = {
  kind: AgentTeamKind.TASK,
  key: 'task:room:old',
  roomId: 'room',
  roundId: 'old',
  sourceSessionId: 'source',
} as AgentTeamHistoryEntry;
const navigation = { requestTransition: vi.fn(async () => true), isCurrent: vi.fn(() => true) };
beforeEach(() => {
  vi.clearAllMocks();
  navigation.requestTransition.mockResolvedValue(true);
  navigation.isCurrent.mockReturnValue(true);
  state.cowork.currentSession.id = 'source';
  vi.mocked(coworkService.loadSession).mockResolvedValue({ id: 'source' } as never);
});
it('opens the exact historical collaboration batch instead of selecting the latest or a group', async () => {
  const received = vi.fn();
  window.addEventListener(OPEN_TEAM_PANEL, received);
  try {
    await openTeamHistoryEntry(task, navigation);
    expect(received.mock.calls[0][0].detail).toEqual({
      sessionId: 'source',
      roomId: 'room',
      teamKey: task.key,
    });
    expect(navigation.requestTransition).toHaveBeenCalledWith({ preserveTabs: true });
  } finally {
    window.removeEventListener(OPEN_TEAM_PANEL, received);
  }
});
it('preserves navigation cancellation and does not load a source on rejection', async () => {
  navigation.requestTransition.mockResolvedValue(false);
  await openTeamHistoryEntry(task, navigation);
  expect(coworkService.loadSession).not.toHaveBeenCalled();
});
it('rejects absent collaboration sources instead of presenting a fabricated graph', async () => {
  vi.mocked(coworkService.loadSession).mockResolvedValue(null);
  await expect(openTeamHistoryEntry(task, navigation)).rejects.toThrow('teamHistoryOpenFailed');
});
it('invalidates a delayed collaboration source selection when the picker closes', async () => {
  let finish!: () => void;
  vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    expect(options?.canSelect?.()).toBe(false);
    return null;
  });
  const result = openTeamHistoryEntry(task, navigation);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  navigation.isCurrent.mockReturnValue(false);
  finish();
  await result;
});
it('retains group navigation and its standalone fallback', async () => {
  const discussion = { id: 'group' } as NonNullable<AgentTeamHistoryEntry['discussion']>;
  await openTeamHistoryEntry({ ...task, kind: AgentTeamKind.GROUP, discussion }, navigation);
  expect(openTeamPanel).toHaveBeenCalledWith(discussion, navigation);
  expect(coworkService.loadSession).not.toHaveBeenCalled();
});
