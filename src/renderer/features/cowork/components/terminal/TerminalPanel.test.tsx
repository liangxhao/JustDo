// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultConfig } from '@/app/config';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

const mocks = vi.hoisted(() => {
  const disposeInput = vi.fn();
  let terminalDataListener: ((data: string) => void) | undefined;
  const terminal = {
    cols: 100,
    rows: 30,
    options: {},
    textarea: undefined as HTMLTextAreaElement | undefined,
    attachCustomKeyEventHandler: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(() => ''),
    hasSelection: vi.fn(() => false),
    loadAddon: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      terminalDataListener = listener;
      return { dispose: disposeInput };
    }),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    open: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    reset: vi.fn(),
    write: vi.fn(),
  };
  const search = {
    clearDecorations: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return {
    disposeInput,
    emitTerminalData: (data: string) => terminalDataListener?.(data),
    fit: vi.fn(),
    search,
    terminal,
    Terminal: vi.fn(function TerminalMock() {
      return terminal;
    }),
    webglContextLoss: vi.fn(),
  };
});

vi.mock('@xterm/xterm', () => ({ Terminal: mocks.Terminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    return { fit: mocks.fit };
  }),
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function SearchAddonMock() {
    return mocks.search;
  }),
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function WebLinksAddonMock() {
    return { dispose: vi.fn() };
  }),
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddonMock() {
    return { dispose: vi.fn(), onContextLoss: mocks.webglContextLoss };
  }),
}));

import TerminalPanel from './TerminalPanel';

describe('TerminalPanel', () => {
  const create = vi.fn().mockResolvedValue({ success: true, cwd: 'E:\\workspace\\JustDo' });
  const close = vi.fn().mockResolvedValue({ success: true });
  const resize = vi.fn().mockResolvedValue({ success: true });
  const write = vi.fn().mockResolvedValue({ success: true });

  beforeEach(() => {
    vi.clearAllMocks();
    i18nService.setLanguage('en', { persist: false });
    mocks.terminal.textarea = document.createElement('textarea');
    mocks.terminal.getSelection.mockReturnValue('');
    mocks.terminal.hasSelection.mockReturnValue(false);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue('clipboard text'),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        platform: 'win32',
        shell: { openExternal: vi.fn().mockResolvedValue({ success: true }) },
        terminal: {
          create,
          close,
          resize,
          write,
          onData: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
          onStatus: vi.fn(() => vi.fn()),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts in the supplied project directory and closes the PTY on unmount', async () => {
    const view = render(
      <TerminalPanel terminalId="terminal:test" cwd={'E:\\workspace\\JustDo'} isObscured={false} />,
    );

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        id: 'terminal:test:00000000-0000-4000-8000-000000000001',
        cwd: 'E:\\workspace\\JustDo',
        cols: 100,
        rows: 30,
      }),
    );
    expect(mocks.Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTransparency: false,
        convertEol: false,
        customGlyphs: true,
        drawBoldTextInBrightColors: true,
        fontFamily: expect.stringMatching(
          /^'MesloLGM Nerd Font'.*'MesloLGM Nerd Font Mono'.*'Microsoft YaHei'.*monospace$/,
        ),
        theme: expect.objectContaining({
          background: '#0c0c0c',
          foreground: '#cccccc',
          brightBlue: '#3b78ff',
          brightCyan: '#61d6d6',
        }),
        windowsPty: { backend: 'conpty' },
      }),
    );
    expect(mocks.webglContextLoss).toHaveBeenCalledOnce();
    view.unmount();
    await waitFor(() =>
      expect(close).toHaveBeenCalledWith('terminal:test:00000000-0000-4000-8000-000000000001'),
    );
    expect(mocks.terminal.dispose).toHaveBeenCalled();
  });

  it('handles a configured panel shortcut before xterm consumes it', async () => {
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...defaultConfig,
      shortcuts: {
        ...defaultConfig.shortcuts!,
        terminal: 'Ctrl+K',
      },
    });
    const shortcutListener = vi.fn();
    window.addEventListener('cowork:shortcut:terminal', shortcutListener);

    const view = render(
      <TerminalPanel
        terminalId="terminal:shortcut"
        cwd={'E:\\workspace\\JustDo'}
        isObscured={false}
      />,
    );

    await waitFor(() => expect(mocks.terminal.attachCustomKeyEventHandler).toHaveBeenCalled());
    const handlerCalls = mocks.terminal.attachCustomKeyEventHandler.mock.calls;
    const handler = handlerCalls[handlerCalls.length - 1]?.[0] as (event: KeyboardEvent) => boolean;
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      cancelable: true,
    });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');

    expect(handler(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(shortcutListener).toHaveBeenCalledOnce();

    window.removeEventListener('cowork:shortcut:terminal', shortcutListener);
    view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('forwards the files shortcut before xterm consumes it', async () => {
    const shortcutListener = vi.fn();
    window.addEventListener('cowork:shortcut:files', shortcutListener);

    const view = render(
      <TerminalPanel
        terminalId="terminal:files-shortcut"
        cwd={'E:\\workspace\\JustDo'}
        isObscured={false}
      />,
    );

    await waitFor(() => expect(mocks.terminal.attachCustomKeyEventHandler).toHaveBeenCalled());
    const handlerCalls = mocks.terminal.attachCustomKeyEventHandler.mock.calls;
    const handler = handlerCalls[handlerCalls.length - 1]?.[0] as (event: KeyboardEvent) => boolean;
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      cancelable: true,
    });

    expect(handler(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(shortcutListener).toHaveBeenCalledOnce();

    window.removeEventListener('cowork:shortcut:files', shortcutListener);
    view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('forwards the review shortcut before xterm consumes it', async () => {
    const shortcutListener = vi.fn();
    window.addEventListener('cowork:shortcut:review', shortcutListener);

    const view = render(
      <TerminalPanel
        terminalId="terminal:review-shortcut"
        cwd={'E:\\workspace\\JustDo'}
        isObscured={false}
      />,
    );

    await waitFor(() => expect(mocks.terminal.attachCustomKeyEventHandler).toHaveBeenCalled());
    const handlerCalls = mocks.terminal.attachCustomKeyEventHandler.mock.calls;
    const handler = handlerCalls[handlerCalls.length - 1]?.[0] as (event: KeyboardEvent) => boolean;
    const event = new KeyboardEvent('keydown', {
      key: 'g',
      shiftKey: true,
      ctrlKey: true,
      cancelable: true,
    });

    expect(handler(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(shortcutListener).toHaveBeenCalledOnce();

    window.removeEventListener('cowork:shortcut:review', shortcutListener);
    view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('reuses the backend PTY across the React StrictMode effect check', async () => {
    const exitListeners: Array<(event: { id: string; exitCode: number }) => void> = [];
    window.electron.terminal.onExit = vi.fn(listener => {
      exitListeners.push(listener);
      return vi.fn();
    });

    const view = render(
      <StrictMode>
        <TerminalPanel
          terminalId="terminal:strict"
          cwd={'E:\\workspace\\JustDo'}
          isObscured={false}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();

    act(() => {
      exitListeners[exitListeners.length - 1]?.({
        id: 'terminal:strict:an-old-process',
        exitCode: -1_073_741_510,
      });
    });
    expect(mocks.terminal.write).not.toHaveBeenCalledWith(expect.stringContaining('-1073741510'));

    view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('cancels pending admission on unmount without waiting for the create reply', async () => {
    let settle!: (result: { success: boolean }) => void;
    create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settle = resolve;
        }),
    );
    const view = render(
      <TerminalPanel
        terminalId="terminal:pending"
        cwd={'E:\\workspace\\JustDo'}
        isObscured={false}
      />,
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    view.unmount();
    await waitFor(() =>
      expect(close).toHaveBeenCalledWith('terminal:pending:00000000-0000-4000-8000-000000000001'),
    );
    await act(async () => settle({ success: false }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows a localized error when terminal creation IPC rejects', async () => {
    i18nService.setLanguage('en', { persist: false });
    create.mockRejectedValueOnce(new Error('IPC unavailable'));

    render(
      <TerminalPanel
        terminalId="terminal:rejected"
        cwd={'E:\\workspace\\JustDo'}
        isObscured={false}
      />,
    );

    await waitFor(() =>
      expect(mocks.terminal.write).toHaveBeenCalledWith('\r\nUnable to create terminal\r\n'),
    );
    expect(mocks.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('IPC unavailable'),
    );
  });

  it('binds a new chat terminal to its product session and pauses input while disconnected', async () => {
    let status: ((event: { id: string; ready: boolean }) => void) | undefined;
    window.electron.terminal.onStatus = vi.fn(listener => {
      status = listener;
      return vi.fn();
    });
    render(
      <TerminalPanel
        terminalId="terminal:chat"
        sessionId="chat-1"
        cwd="C:/project"
        isObscured={false}
      />,
    );
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1' })),
    );
    await waitFor(() => expect(mocks.terminal.focus).toHaveBeenCalled());
    const id = create.mock.calls[create.mock.calls.length - 1][0].id;
    act(() => status?.({ id, ready: false }));
    mocks.emitTerminalData('ignored while offline');
    expect(write).not.toHaveBeenCalled();
    act(() => status?.({ id, ready: true }));
    mocks.emitTerminalData('human input');
    expect(write).toHaveBeenCalledWith({ id, data: 'human input' });
  });

  it('does not send xterm control replies while native historical buffers are being redrawn', async () => {
    let data: ((event: { id: string; data: string; reset?: boolean }) => void) | undefined;
    const callbacks: Array<() => void> = [];
    window.electron.terminal.onData = vi.fn(listener => {
      data = listener;
      return vi.fn();
    });
    mocks.terminal.write.mockImplementation((_text: string, callback?: () => void) => {
      if (callback) callbacks.push(callback);
    });
    render(<TerminalPanel terminalId="terminal:replay" cwd="C:/project" isObscured={false} />);
    await waitFor(() => expect(mocks.terminal.focus).toHaveBeenCalled());
    const id = create.mock.calls[create.mock.calls.length - 1][0].id;
    act(() => {
      data?.({ id, data: 'old buffer', reset: true });
      data?.({ id, data: 'newer buffer', reset: true });
    });
    mocks.emitTerminalData('historical control reply');
    expect(write).not.toHaveBeenCalled();
    callbacks[0]();
    mocks.emitTerminalData('another historical control reply');
    expect(write).not.toHaveBeenCalled();
    callbacks[1]();
    mocks.emitTerminalData('fresh input');
    expect(write).toHaveBeenCalledWith({ id, data: 'fresh input' });
    mocks.terminal.write.mockReset();
  });

  it('commits Windows IME composition text exactly once', async () => {
    render(
      <TerminalPanel terminalId="terminal:ime" cwd={'E:\\workspace\\JustDo'} isObscured={false} />,
    );

    await waitFor(() => expect(mocks.terminal.focus).toHaveBeenCalled());
    const textarea = mocks.terminal.textarea;
    expect(textarea).toBeDefined();

    fireEvent.compositionStart(textarea!);
    fireEvent.compositionUpdate(textarea!, { data: '你好' });
    fireEvent.compositionEnd(textarea!, { data: '你好' });
    mocks.emitTerminalData('你好');

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        id: 'terminal:ime:00000000-0000-4000-8000-000000000001',
        data: '你好',
      }),
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(textarea?.value).toBe('');
  });

  it('copies selected terminal output from the context menu', async () => {
    mocks.terminal.hasSelection.mockReturnValue(true);
    mocks.terminal.getSelection.mockReturnValue('selected output');
    const view = render(
      <TerminalPanel terminalId="terminal:menu" cwd={'E:\\workspace\\JustDo'} isObscured={false} />,
    );
    await waitFor(() => expect(mocks.terminal.focus).toHaveBeenCalled());

    fireEvent.contextMenu(view.getByLabelText('Terminal'), { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected output'),
    );
  });
});
