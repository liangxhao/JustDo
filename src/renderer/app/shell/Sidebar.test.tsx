// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appBrowserRegistry } from '@/features/plugins/app/runtime';
import { translations } from '@/services/i18n/translations';

import Sidebar from './Sidebar';
import { SidebarView } from './sidebarNavigation';

const state = vi.hoisted(() => ({
  cowork: { sessionListStatus: 'ready', sessionRuntimeActivity: {} as Record<string, boolean> },
  scheduledTask: { unreadResultCount: 0 },
}));
const config = vi.hoisted(() => ({ developerMode: false, controlUiEnabled: false }));
const exportSession = vi.hoisted(() => vi.fn());
const exportSource = vi.hoisted(() => ({ id: 'target-chat', title: 'Target chat', status: 'idle' }));

vi.mock('react-redux', () => ({
  useSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@/store', () => ({ store: { getState: () => state } }));
vi.mock('@/features/cowork/coworkSelectors', () => ({
  selectCoworkSessions: () => [exportSource],
  selectSessionDirectory: () => [exportSource],
  selectGroups: () => [],
  selectCurrentSessionId: () => 'existing-chat',
  selectIsOpenClawEngine: () => true,
}));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: {} }));
vi.mock('@/features/cowork/components/sessions/CoworkSessionList', () => ({
  default: ({ onExportSession }: { onExportSession: (sessionId: string) => void }) => (
    <button type="button" onClick={() => onExportSession(exportSource.id)}>Export target</button>
  ),
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
  config.controlUiEnabled = false;
  state.cowork.sessionRuntimeActivity = {};
  exportSession.mockReset();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', cowork: { exportSession } },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  it('exports the selected row without opening its conversation and passes the raw data choice', async () => {
    exportSession.mockResolvedValue({ success: true, canceled: false });
    const props = createProps();
    render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export target' }));
    const options = within(screen.getByRole('dialog', { name: translations.zh.sessionExportMain }));
    expect(options.getByText('Target chat')).toBeTruthy();
    const includeRaw = options.getByRole('checkbox', { name: translations.zh.coworkExportIncludeRaw });
    expect((includeRaw as HTMLInputElement).checked).toBe(true);
    fireEvent.click(includeRaw);
    fireEvent.click(options.getByRole('button', { name: translations.zh.coworkExportSave }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(exportSession).toHaveBeenCalledExactlyOnceWith({ sessionId: exportSource.id, includeRawData: false });
    expect(props.onShowCowork).not.toHaveBeenCalled();
    expect(props.onBeforeCoworkNavigation).not.toHaveBeenCalled();
  });

  it.each(['plugin', 'runtime'] as const)('rechecks %s restrictions before sending the export', restriction => {
    const spy = vi.spyOn(appBrowserRegistry, 'sessionPresentation').mockReturnValue({});
    render(<Sidebar {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export target' }));
    if (restriction === 'plugin') spy.mockReturnValue({ exportAllowed: false });
    else state.cowork.sessionRuntimeActivity[exportSource.id] = true;

    const dispatch = vi.spyOn(window, 'dispatchEvent');
    fireEvent.click(screen.getByRole('button', { name: translations.zh.coworkExportSave }));

    expect(exportSession).not.toHaveBeenCalled();
    const toast = dispatch.mock.calls.map(([event]) => event as CustomEvent)
      .find(event => event.type === 'app:showToast');
    expect(toast?.detail).toBe(restriction === 'plugin'
      ? translations.zh.coworkExportFailed
      : translations.zh.coworkExportWaitForCompletion);
  });

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
    expect(screen.getByRole('button', { name: translations.zh.authLogin })).toBeTruthy();
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
      expect(screen.getByRole('button', { name: translations.zh.authLogin })).toBeTruthy();
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

  it.each([false, true])('keeps WebChat out of More when Control UI is %s', enabled => {
    config.developerMode = true;
    config.controlUiEnabled = enabled;
    render(<Sidebar {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: translations.zh.sidebarMore }));
    expect(screen.queryByRole('button', { name: translations.zh.openChatWeb })).toBeNull();
  });
});
