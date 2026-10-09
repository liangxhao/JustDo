// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';
import { translations } from '@/services/i18n/translations';

import NavigationRail from './NavigationRail';
import { SidebarView } from './sidebarNavigation';

const config = vi.hoisted(() => ({ sidebarPinnedItems: [] as unknown }));

vi.mock('@/services/config', () => ({
  configService: {
    getConfig: vi.fn(() => config),
    updateConfig: vi.fn(async (patch: { sidebarPinnedItems: string[] }) => {
      config.sidebarPinnedItems = patch.sidebarPinnedItems;
      window.dispatchEvent(new CustomEvent('config-updated'));
    }),
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => translations.zh[key] ?? key,
  },
}));

const createProps = () => ({
  activeView: SidebarView.Home,
  homePanelId: 'sidebar-home-panel',
  isHomePanelExpanded: true,
  showWorkboard: true,
  unreadScheduledTaskResults: 0,
  onShowHome: vi.fn(),
  onShowScheduledTasks: vi.fn(),
  onShowPlugins: vi.fn(),
  onShowMemory: vi.fn(),
  onShowWorkboard: vi.fn(),
  onShowSettings: vi.fn(),
});

beforeEach(() => {
  config.sidebarPinnedItems = [];
  vi.clearAllMocks();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32' },
  });
});

afterEach(cleanup);

describe('NavigationRail', () => {
  it('keeps the four default entries in order and settings at the end', () => {
    const props = createProps();
    render(<NavigationRail {...props} />);
    const buttons = within(screen.getByRole('navigation')).getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      '主页',
      translations.zh.scheduledTasks,
      translations.zh.plugins,
      '更多',
      translations.zh.authLogin,
      translations.zh.settings,
    ]);
    expect(buttons[0].getAttribute('aria-current')).toBe('page');
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[2]);
    fireEvent.click(buttons[5]);
    expect(props.onShowHome).toHaveBeenCalledOnce();
    expect(props.onShowScheduledTasks).toHaveBeenCalledOnce();
    expect(props.onShowPlugins).toHaveBeenCalledOnce();
    expect(props.onShowSettings).toHaveBeenCalledOnce();
  });

  it('pins from More without navigating, restores saved pins and allows unpinning', async () => {
    const props = createProps();
    const firstMount = render(<NavigationRail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const memoryLabel = translations.zh.memoryTitle;
    fireEvent.click(screen.getByRole('button', { name: `将${memoryLabel}固定到侧边栏` }));
    await waitFor(() => {
      expect(configService.updateConfig).toHaveBeenCalledWith({ sidebarPinnedItems: ['memory'] });
      expect(
        within(screen.getByRole('navigation')).getByRole('button', { name: memoryLabel }),
      ).toBeTruthy();
    });
    expect(props.onShowMemory).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '更多' })).toBeTruthy();
    firstMount.unmount();

    render(<NavigationRail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: memoryLabel }));
    expect(props.onShowMemory).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('button', { name: `取消固定${memoryLabel}` }));
    await waitFor(() => {
      expect(config.sidebarPinnedItems).toEqual([]);
      expect(
        within(screen.getByRole('navigation')).queryByRole('button', { name: memoryLabel }),
      ).toBeNull();
    });
  });

  it('opens optional pages from More and closes it without changing pins', () => {
    const props = createProps();
    render(<NavigationRail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: translations.zh.workboard }),
    );
    expect(props.onShowWorkboard).toHaveBeenCalledOnce();
    expect(configService.updateConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides disabled Workboard entries while preserving their saved order', () => {
    config.sidebarPinnedItems = ['workboard', 'unknown', 'memory', 'memory'];
    const props = createProps();
    const { rerender } = render(<NavigationRail {...props} showWorkboard={false} />);
    const rail = within(screen.getByRole('navigation'));
    expect(rail.queryByRole('button', { name: translations.zh.workboard })).toBeNull();
    expect(rail.getAllByRole('button', { name: translations.zh.memoryTitle })).toHaveLength(1);
    fireEvent.click(rail.getByRole('button', { name: '更多' }));
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: translations.zh.workboard }),
    ).toBeNull();
    expect(configService.updateConfig).not.toHaveBeenCalled();
    rerender(<NavigationRail {...props} />);
    const pinnedButtons = rail.getAllByRole('button').slice(4, -2);
    expect(pinnedButtons.map(button => button.getAttribute('aria-label'))).toEqual([
      translations.zh.workboard,
      translations.zh.memoryTitle,
    ]);
  });

  it('retains confirmed pins on a failed save and reports the failure', async () => {
    const onToast = vi.fn();
    window.addEventListener('app:showToast', onToast);
    vi.mocked(configService.updateConfig).mockRejectedValueOnce(new Error('write failed'));
    render(<NavigationRail {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(
      screen.getByRole('button', { name: `将${translations.zh.memoryTitle}固定到侧边栏` }),
    );
    await waitFor(() => expect(onToast).toHaveBeenCalledOnce());
    expect((onToast.mock.calls[0][0] as CustomEvent).detail).toBe(
      translations.zh.sidebarPinSaveFailed,
    );
    expect(config.sidebarPinnedItems).toEqual([]);
    expect(
      within(screen.getByRole('navigation')).queryByRole('button', {
        name: translations.zh.memoryTitle,
      }),
    ).toBeNull();
    window.removeEventListener('app:showToast', onToast);
  });

  it('serializes pin clicks while a save is pending', async () => {
    let finishSave!: () => void;
    vi.mocked(configService.updateConfig).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishSave = () => {
            config.sidebarPinnedItems = ['memory'];
            resolve();
          };
        }),
    );
    render(<NavigationRail {...createProps()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(
      screen.getByRole('button', { name: `将${translations.zh.memoryTitle}固定到侧边栏` }),
    );
    const workboardPin = screen.getByRole('button', {
      name: `将${translations.zh.workboard}固定到侧边栏`,
    }) as HTMLButtonElement;
    expect(workboardPin.disabled).toBe(true);
    fireEvent.click(workboardPin);
    expect(configService.updateConfig).toHaveBeenCalledOnce();
    await act(async () => finishSave());
    expect(workboardPin.disabled).toBe(false);
  });

  it('dismisses More on Escape with focus restored and on outside clicks', () => {
    render(<NavigationRail {...createProps()} />);
    const more = screen.getByRole('button', { name: '更多' });
    fireEvent.click(more);
    expect(document.activeElement?.textContent).toBe(translations.zh.memoryTitle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('includes unread result counts in the task button and reflects external config updates', () => {
    render(<NavigationRail {...createProps()} unreadScheduledTaskResults={120} />);
    const tasks = screen.getByRole('button', {
      name: `${translations.zh.scheduledTasks}, 120 ${translations.zh.scheduledTasksResultsUnreadLabel}`,
    });
    expect(tasks.textContent).toBe('99+');
    act(() => {
      config.sidebarPinnedItems = ['memory'];
      window.dispatchEvent(new CustomEvent('config-updated'));
    });
    expect(screen.getByRole('button', { name: translations.zh.memoryTitle })).toBeTruthy();
  });
});
