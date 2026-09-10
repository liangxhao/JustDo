import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const templates: Array<Array<{ label?: string; type?: string; click?: () => void }>> = [];
  const listeners = new Map<string, () => void>();
  const tray = {
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => listeners.set(event, handler)),
    popUpContextMenu: vi.fn(),
    removeListener: vi.fn(),
    setToolTip: vi.fn(),
  };

  return {
    app: { isPackaged: false, quit: vi.fn(), relaunch: vi.fn() },
    image: {
      getSize: vi.fn(() => ({ height: 16 })),
      resize: vi.fn(),
      setTemplateImage: vi.fn(),
    },
    listeners,
    templates,
    tray,
  };
});

vi.mock('electron', () => ({
  app: electronMocks.app,
  Menu: {
    buildFromTemplate: vi.fn(
      (template: Array<{ label?: string; type?: string; click?: () => void }>) => {
        electronMocks.templates.push(template);
        return { template };
      },
    ),
  },
  nativeImage: { createFromPath: vi.fn(() => electronMocks.image) },
  Tray: vi.fn(function () {
    return electronMocks.tray;
  }),
}));

import { setLanguage } from './i18n';
import { createTray, destroyTray, updateTrayMenu } from './trayManager';

describe('trayManager', () => {
  beforeEach(() => {
    destroyTray();
    setLanguage('zh');
    electronMocks.templates.length = 0;
    electronMocks.listeners.clear();
    vi.clearAllMocks();
  });

  test('shows one conversation action that opens the window and starts a new task', () => {
    const win = {
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      webContents: { send: vi.fn() },
    };

    createTray(() => win as never);

    const template = electronMocks.templates.at(-1);
    expect(template?.map(item => item.label ?? item.type)).toEqual([
      '发起对话',
      'separator',
      '设置',
      'separator',
      '重启软件',
      '退出',
    ]);

    template?.[0].click?.();

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('app:newTask');
  });

  test('uses the English conversation label after the tray menu language updates', () => {
    createTray(() => null);
    setLanguage('en');

    updateTrayMenu(() => null);

    expect(electronMocks.templates.at(-1)?.[0].label).toBe('Start Conversation');
  });

  test('relaunches the application through its normal quit flow', () => {
    createTray(() => null);

    electronMocks.templates.at(-1)?.[4].click?.();

    expect(electronMocks.app.relaunch).toHaveBeenCalledOnce();
    expect(electronMocks.app.quit).toHaveBeenCalledOnce();
    expect(electronMocks.app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(
      electronMocks.app.quit.mock.invocationCallOrder[0],
    );
  });
});
