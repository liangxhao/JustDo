// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import Sidebar from './Sidebar';
import { SidebarView } from './sidebarNavigation';

const state = vi.hoisted(() => ({
  cowork: { sessionListStatus: 'ready' },
  scheduledTask: { unreadResultCount: 0 },
}));
const config = vi.hoisted(() => ({ developerMode: false }));

vi.mock('react-redux', () => ({
  useSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@/store', () => ({ store: { getState: () => state } }));
vi.mock('@/features/cowork/components/chat/CollaborationPanel', () => ({
  useCollaborationRooms: () => [],
}));
vi.mock('@/features/cowork/coworkSelectors', () => ({
  selectCoworkSessions: () => [],
  selectGroups: () => [],
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
  configService: { getConfig: () => config },
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.zh[key] ?? key },
}));

beforeEach(() => {
  config.developerMode = false;
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
  it('toggles the home list through Home while keeping navigation available', () => {
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
    const home = screen.getByRole('button', { name: '主页' });
    expect(home.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: translations.zh.collapse })).toBeNull();
    fireEvent.click(home);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(home.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('navigation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '主页' }));
    expect(screen.getByRole('complementary', { name: '主页' })).toBeTruthy();
    expect(home.getAttribute('aria-expanded')).toBe('true');
    expect(props.onShowCowork).toHaveBeenCalledTimes(2);
    expect(props.onNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: translations.zh.newChat }));
    expect(props.onNewChat).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'opens the home list from another page with collapsed=%s',
    initialCollapsed => {
      const props = createProps();
      const Shell = () => {
        const [activeView, setActiveView] = useState<SidebarView>(SidebarView.Plugins);
        const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
        return (
          <Sidebar
            {...props}
            activeView={activeView}
            isCollapsed={isCollapsed}
            onShowCowork={() => setActiveView(SidebarView.Home)}
            onToggleCollapse={() => setIsCollapsed(value => !value)}
          />
        );
      };
      render(<Shell />);
      const home = screen.getByRole('button', { name: '主页' });
      expect(screen.queryByRole('complementary')).toBeNull();
      fireEvent.click(home);
      expect(screen.getByRole('complementary', { name: '主页' })).toBeTruthy();
      expect(home.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(home);
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(home.getAttribute('aria-expanded')).toBe('false');
      expect(props.onNewChat).not.toHaveBeenCalled();
    },
  );

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

  it('opens WebChat from More in developer mode even when the home list is collapsed', async () => {
    config.developerMode = true;
    const openExternal = vi.fn(async () => undefined);
    const getPort = vi.fn(async () => ({ success: true, port: 18789 }));
    const getToken = vi.fn(async () => ({ success: true, token: 'test-only-token' }));
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        platform: 'win32',
        openclaw: { engine: { getPort, getToken } },
        shell: { openExternal },
      },
    });
    const props = createProps();
    render(<Sidebar {...props} isCollapsed />);
    expect(screen.queryByRole('button', { name: translations.zh.openChatWeb })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: translations.zh.sidebarMore }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: translations.zh.sidebarMore })).getByRole(
        'button',
        { name: translations.zh.openChatWeb },
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:18789/#token=test-only-token'),
    );
    expect(props.onShowCowork).not.toHaveBeenCalled();
  });

  it('keeps WebChat hidden outside developer mode and updates an open More menu on mode changes', () => {
    render(<Sidebar {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: translations.zh.sidebarMore }));
    const more = within(screen.getByRole('dialog', { name: translations.zh.sidebarMore }));
    expect(more.queryByRole('button', { name: translations.zh.openChatWeb })).toBeNull();
    config.developerMode = true;
    fireEvent(window, new Event('config-updated'));
    expect(more.getByRole('button', { name: translations.zh.openChatWeb })).toBeTruthy();
    expect(
      within(screen.getByRole('complementary')).queryByRole('button', {
        name: translations.zh.openChatWeb,
      }),
    ).toBeNull();
    config.developerMode = false;
    fireEvent(window, new Event('config-updated'));
    expect(more.queryByRole('button', { name: translations.zh.openChatWeb })).toBeNull();
  });
});
