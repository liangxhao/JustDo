// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import Sidebar from './Sidebar';
import { SidebarView } from './sidebarNavigation';

const state = vi.hoisted(() => ({
  cowork: { sessionListStatus: 'ready' },
  scheduledTask: { unreadResultCount: 0 },
}));

vi.mock('react-redux', () => ({
  useSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@/store', () => ({ store: { getState: () => state } }));
vi.mock('@/features/cowork/components/chat/CollaborationPanel', () => ({
  useCollaborationRooms: () => [],
}));
vi.mock('@/features/cowork/coworkSelectors', () => ({
  selectCoworkSessions: () => [],
  selectCurrentSessionId: () => 'existing-chat',
  selectIsOpenClawEngine: () => true,
}));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: {} }));
vi.mock('@/features/cowork/components/sessions/CoworkSessionList', () => ({
  default: () => <div>session-list</div>,
}));
vi.mock('@/features/cowork/components/sessions/CoworkSearchModal', () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">session-search</div> : null,
}));
vi.mock('@/services/config', () => ({
  configService: { getConfig: () => ({ developerMode: false }) },
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.zh[key] ?? key },
}));

beforeEach(() => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32' },
  });
});
afterEach(cleanup);

const createProps = () => ({
  onShowSettings: vi.fn(),
  activeView: SidebarView.Home,
  onShowCowork: vi.fn(),
  onShowScheduledTasks: vi.fn(),
  onShowWorkboard: vi.fn(),
  showWorkboard: true,
  onShowMemory: vi.fn(),
  onShowPlugins: vi.fn(),
  onNewChat: vi.fn(),
  onBeforeCoworkNavigation: vi.fn(async () => true),
  isCollapsed: false,
  onToggleCollapse: vi.fn(),
});

describe('Sidebar', () => {
  it('keeps navigation available when the home list is collapsed and restores it via Home', () => {
    const props = createProps();
    const Shell = () => {
      const [isCollapsed, setIsCollapsed] = useState(false);
      return (
        <Sidebar
          {...props}
          isCollapsed={isCollapsed}
          onToggleCollapse={() => setIsCollapsed(value => !value)}
        />
      );
    };
    render(<Shell />);
    expect(screen.getByRole('complementary', { name: '主页' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: translations.zh.collapse }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('navigation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '主页' }));
    expect(screen.getByRole('complementary', { name: '主页' })).toBeTruthy();
    expect(props.onShowCowork).toHaveBeenCalledOnce();
    expect(props.onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: translations.zh.newChat }));
    expect(props.onNewChat).toHaveBeenCalledOnce();
  });

  it('shows the home list only on Home, preserving feature navigation and settings elsewhere', () => {
    const props = createProps();
    const { rerender } = render(<Sidebar {...props} />);
    for (const activeView of [
      SidebarView.ScheduledTasks,
      SidebarView.Plugins,
      SidebarView.Memory,
      SidebarView.Workboard,
    ]) {
      rerender(<Sidebar {...props} activeView={activeView} />);
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(screen.getByRole('button', { name: '主页' })).toBeTruthy();
      expect(screen.getByRole('button', { name: translations.zh.settings })).toBeTruthy();
    }
    rerender(<Sidebar {...props} />);
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('opens search by shortcut even when the home list is collapsed', () => {
    const props = createProps();
    render(<Sidebar {...props} isCollapsed />);
    fireEvent(window, new Event('cowork:shortcut:search'));
    expect(screen.getByRole('dialog').textContent).toBe('session-search');
    expect(props.onShowCowork).toHaveBeenCalledOnce();
  });
});
