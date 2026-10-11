// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { requestCoworkSessionListAction } from '@/features/cowork/sessionListActions';

import Sidebar from './Sidebar';

const state = vi.hoisted(() => ({
  cowork: { sessions: [], currentSession: { id: 'source' }, sessionListStatus: 'ready' },
  scheduledTask: { unreadResultCount: 0 },
}));
vi.mock('react-redux', () => ({
  useSelector: (select: (value: unknown) => unknown) => select(state),
}));
vi.mock('@/store', () => ({ store: { getState: () => state } }));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: { loadSession: vi.fn() } }));
vi.mock('@/features/cowork/coworkSelectors', () => ({
  selectCoworkSessions: () => [],
  selectCurrentSessionId: () => 'source',
  selectGroups: () => [],
  selectIsOpenClawEngine: () => true,
}));
vi.mock('@/features/cowork/components/collaboration/CollaborationPanel', () => ({
  useCollaborationRooms: () => [],
}));
vi.mock('@/features/cowork/components/sessions/CoworkSearchModal', () => ({ default: () => null }));
vi.mock('@/features/cowork/components/sessions/CoworkSessionList', () => ({
  default: ({ onCollaborationSession }: { onCollaborationSession: (id: string) => void }) => (
    <button onClick={() => onCollaborationSession('source')}>collaboration</button>
  ),
}));
vi.mock('@/features/cowork/sessionListActions', () => ({
  requestCoworkSessionListAction: vi.fn(),
}));
vi.mock('@/features/auth/AuthEntry', () => ({ default: () => null }));
vi.mock('@/services/config', () => ({
  configService: { getConfig: () => ({ sidebarPinnedItems: ['memory', 'workboard'] }) },
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electron', { configurable: true, value: { platform: 'win32' } });
});
afterEach(cleanup);

it.each([
  'plugins',
  'memoryTitle',
  'scheduledTasks',
  'workboard',
  'newChat',
  'settings',
  'sidebarHome',
  'unmount',
])('does not reopen delayed collaboration details after navigating to %s', async destination => {
  let finish!: () => void;
  vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    if (options?.canSelect?.() === false) return null;
    return { id: 'source' } as never;
  });
  const view = render(
    <Sidebar
      activeView="cowork"
      onShowSettings={vi.fn()}
      onShowCowork={vi.fn()}
      onShowScheduledTasks={vi.fn()}
      onShowWorkboard={vi.fn()}
      showWorkboard
      onShowMemory={vi.fn()}
      onShowPlugins={vi.fn()}
      onNewChat={vi.fn()}
      onBeforeCoworkNavigation={async () => true}
      isCollapsed={false}
      onToggleCollapse={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'collaboration' }));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  if (destination === 'unmount') view.unmount();
  else fireEvent.click(screen.getByRole('button', { name: destination }));
  await act(async () => {
    finish();
  });
  expect(requestCoworkSessionListAction).not.toHaveBeenCalled();
});

it('keeps normal collaboration navigation valid when selecting its anchor', async () => {
  let finish!: () => void;
  vi.mocked(coworkService.loadSession).mockImplementation(async (_id, options) => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
    if (options?.canSelect?.() === false) return null;
    return { id: 'source' } as never;
  });
  const props = {
    onShowSettings: vi.fn(),
    onShowCowork: vi.fn(),
    onShowScheduledTasks: vi.fn(),
    onShowWorkboard: vi.fn(),
    showWorkboard: true,
    onShowMemory: vi.fn(),
    onShowPlugins: vi.fn(),
    onNewChat: vi.fn(),
    onBeforeCoworkNavigation: async () => true,
    isCollapsed: false,
    onToggleCollapse: vi.fn(),
  };
  const view = render(<Sidebar {...props} activeView="cowork" />);
  fireEvent.click(screen.getByRole('button', { name: 'collaboration' }));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(props.onShowCowork).toHaveBeenCalledOnce();
  view.rerender(<Sidebar {...props} activeView="cowork" />);
  await act(async () => {
    finish();
  });
  expect(requestCoworkSessionListAction).toHaveBeenCalledWith({
    action: 'collaboration',
    sessionId: 'source',
  });
});
