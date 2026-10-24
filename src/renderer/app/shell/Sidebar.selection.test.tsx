// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { translations } from '@/services/i18n/translations';

import Sidebar from './Sidebar';
import { SidebarView } from './sidebarNavigation';

const sessions = vi.hoisted(() => ['shown', 'shown-other', 'collapsed', 'not-yet-shown'].map(id => ({
  id, title: id, status: 'idle', pinned: false, createdAt: 1, updatedAt: 1,
})));
vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector({
    cowork: { sessionListStatus: 'ready' }, scheduledTask: { unreadResultCount: 0 },
  }),
}));
vi.mock('@/store', () => ({ store: { getState: () => ({ cowork: {} }) } }));
vi.mock('@/features/cowork/coworkSelectors', () => ({
  selectCoworkSessions: () => sessions,
  selectSessionDirectory: () => sessions,
  selectCurrentSessionId: () => null,
  selectGroups: () => [],
  selectIsOpenClawEngine: () => true,
}));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: { deleteSessions: vi.fn() } }));
vi.mock('@/features/cowork/components/collaboration/CollaborationPanel', () => ({
  useCollaborationRooms: () => [],
}));
vi.mock('@/features/cowork/components/sessions/CoworkSearchModal', () => ({ default: () => null }));
vi.mock('@/features/cowork/components/sessions/CoworkSessionList', () => ({
  default: function SessionListMock({ onVisibleSessionIdsChange, onEnterBatchMode }: {
    onVisibleSessionIdsChange: (ids: string[]) => void;
    onEnterBatchMode: (id: string) => void;
  }) {
    useEffect(() => { onVisibleSessionIdsChange(['shown', 'shown-other']); }, [onVisibleSessionIdsChange]);
    return <>
      <button type="button" onClick={() => onEnterBatchMode('shown')}>Select conversation</button>
      <button type="button" onClick={() => onVisibleSessionIdsChange(['shown'])}>Collapse group</button>
    </>;
  },
}));
vi.mock('@/features/auth/AuthEntry', () => ({ default: () => null }));
vi.mock('@/services/config', () => ({ configService: { getConfig: () => ({}) } }));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.en[key] ?? key },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([false, true])('selects and deletes only currently displayed rows, collapse=%s', async collapse => {
  Object.defineProperty(window, 'electron', { configurable: true, value: { platform: 'win32' } });
  render(<Sidebar
    activeView={SidebarView.Home}
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
  />);
  fireEvent.click(screen.getByRole('button', { name: 'Select conversation' }));
  fireEvent.click(screen.getByRole('checkbox', { name: translations.en.batchSelectAll }));
  expect(screen.getByRole('button', { name: '2' })).toBeTruthy();
  if (collapse) fireEvent.click(screen.getByRole('button', { name: 'Collapse group' }));
  fireEvent.click(screen.getByRole('button', { name: collapse ? '1' : '2' }));
  fireEvent.click(screen.getByRole('button', { name: /^Delete/ }));
  await waitFor(() => expect(coworkService.deleteSessions).toHaveBeenCalledExactlyOnceWith(
    collapse ? ['shown'] : ['shown', 'shown-other'],
  ));
});
