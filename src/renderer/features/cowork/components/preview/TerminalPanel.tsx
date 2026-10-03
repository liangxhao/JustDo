import '@xterm/xterm/css/xterm.css';

import { resolveBrowserPanelShortcutAction } from '@shared/browser/browser';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { defaultConfig } from '@/app/config';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import TerminalContextMenu from './TerminalContextMenu';

interface TerminalPanelProps {
  cwd: string;
  isObscured: boolean;
  terminalId: string;
}

// Windows Terminal's Campbell palette keeps PowerShell output familiar while
// still exposing the full ANSI bright-color range used by modern CLI tools.
const TERMINAL_THEME = {
  background: '#0c0c0c',
  foreground: '#cccccc',
  cursor: '#ffffff',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#264f78',
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
};

// Prompt customizers such as Oh My Posh use Nerd Font private-use glyphs for
// Git/status icons. Prefer the common family names used by terminal profiles,
// then their Mono variants, standard monospace fonts, and CJK fallbacks.
const TERMINAL_FONT_FAMILY =
  "'MesloLGM Nerd Font', 'MesloLGL Nerd Font', " +
  "'CaskaydiaCove Nerd Font', 'CaskaydiaMono Nerd Font', " +
  "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', " +
  "'MesloLGM Nerd Font Mono', 'MesloLGL Nerd Font Mono', " +
  "'CaskaydiaCove Nerd Font Mono', 'JetBrainsMono Nerd Font Mono', " +
  "'Cascadia Mono', Consolas, 'Microsoft YaHei UI', 'Microsoft YaHei', " +
  "'PingFang SC', 'Noto Sans Mono CJK SC', monospace";

const ignoreTerminalActionFailure = (operation: Promise<unknown>): void => {
  void operation.catch(() => undefined);
};

const openTerminalWebLink = (event: MouseEvent, uri: string): void => {
  if (!event.ctrlKey && !event.metaKey) return;
  try {
    const protocol = new URL(uri).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return;
    ignoreTerminalActionFailure(window.electron.shell.openExternal(uri));
  } catch {
    // Ignore malformed or unsafe link targets emitted by terminal programs.
  }
};

const TerminalPanel = ({ cwd, isObscured, terminalId }: TerminalPanelProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const backendTerminalIdRef = useRef<string | null>(null);
  const createPromiseRef = useRef<ReturnType<typeof window.electron.terminal.create> | null>(null);
  const backendReadyRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    canCopy: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState({ index: -1, total: 0 });

  const focusTerminal = useCallback(() => terminalRef.current?.focus(), []);

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setIsSearchOpen(false);
    setSearchResult({ index: -1, total: 0 });
    requestAnimationFrame(focusTerminal);
  }, [focusTerminal]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const copySelection = useCallback(() => {
    const selection = terminalRef.current?.getSelection() ?? '';
    if (selection) ignoreTerminalActionFailure(navigator.clipboard.writeText(selection));
  }, []);

  const pasteClipboard = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then(text => {
        if (text) terminalRef.current?.paste(text);
      })
      .catch(() => undefined);
  }, []);

  const find = useCallback((direction: 1 | -1) => {
    const query = searchInputRef.current?.value ?? '';
    if (!query) return;
    const options = {
      decorations: {
        matchOverviewRuler: '#3a96dd',
        activeMatchColorOverviewRuler: '#f9f1a5',
        matchBackground: '#264f78',
        activeMatchBackground: '#c19c00',
      },
    };
    if (direction === 1) searchRef.current?.findNext(query, options);
    else searchRef.current?.findPrevious(query, options);
  }, []);

  useEffect(() => {
    if (!isSearchOpen) return;
    if (!searchQuery) {
      searchRef.current?.clearDecorations();
      setSearchResult({ index: -1, total: 0 });
      return;
    }
    find(1);
  }, [find, isSearchOpen, searchQuery]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const backendTerminalId =
      backendTerminalIdRef.current ?? `${terminalId}:${crypto.randomUUID()}`;
    backendTerminalIdRef.current = backendTerminalId;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      customGlyphs: true,
      drawBoldTextInBrightColors: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      fontWeightBold: 600,
      lineHeight: 1.08,
      rescaleOverlappingGlyphs: true,
      scrollback: 10_000,
      theme: TERMINAL_THEME,
      windowsPty: window.electron.platform === 'win32' ? { backend: 'conpty' } : undefined,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new WebLinksAddon(openTerminalWebLink));
    terminal.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // Chromium may disable WebGL on remote/legacy GPUs; xterm's renderer is
      // still fully functional and provides a safe automatic fallback.
    }
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    let disposed = false;
    let isImeComposing = false;
    let latestCompositionText = '';
    let suppressedCompositionText: string | null = null;
    let suppressionTimer: number | null = null;

    const sendInput = (data: string) => {
      if (backendReadyRef.current) {
        ignoreTerminalActionFailure(
          window.electron.terminal.write({ id: backendTerminalId, data }),
        );
      }
    };

    const fitAndResize = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // A hidden panel can report transient zero dimensions while tabs switch.
      }
    };

    const unsubscribeData = window.electron.terminal.onData(event => {
      if (event.id === backendTerminalId) terminal.write(event.data);
    });
    const unsubscribeExit = window.electron.terminal.onExit(event => {
      if (event.id !== backendTerminalId) return;
      backendReadyRef.current = false;
      terminal.write(
        `\r\n${i18nService.t('coworkTerminalExited').replace('{code}', String(event.exitCode))}\r\n`,
      );
    });
    const inputSubscription = terminal.onData(data => {
      if (isImeComposing) return;
      if (suppressedCompositionText !== null && data === suppressedCompositionText) {
        suppressedCompositionText = null;
        return;
      }
      sendInput(data);
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (backendReadyRef.current) {
        ignoreTerminalActionFailure(
          window.electron.terminal.resize({ id: backendTerminalId, cols, rows }),
        );
      }
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(host);
    fitAndResize();

    const searchResultSubscription = search.onDidChangeResults(event => {
      setSearchResult({ index: event.resultIndex, total: event.resultCount });
    });

    const textarea = terminal.textarea;
    const handleCompositionStart = () => {
      isImeComposing = true;
      latestCompositionText = '';
    };
    const handleCompositionUpdate = (event: CompositionEvent) => {
      latestCompositionText = event.data;
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      const committedText = event.data || latestCompositionText;
      isImeComposing = false;
      latestCompositionText = '';
      // xterm 6 can derive an empty/truncated commit from its retained hidden
      // textarea on Windows TSF IMEs. The DOM event contains the authoritative
      // commit; clearing the helper also prevents a delayed duplicate emission.
      if (textarea) textarea.value = '';
      if (!committedText) return;
      suppressedCompositionText = committedText;
      sendInput(committedText);
      suppressionTimer = window.setTimeout(() => {
        suppressionTimer = null;
        suppressedCompositionText = null;
      }, 0);
    };
    textarea?.addEventListener('compositionstart', handleCompositionStart);
    textarea?.addEventListener('compositionupdate', handleCompositionUpdate);
    textarea?.addEventListener('compositionend', handleCompositionEnd);

    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      const shortcuts = {
        ...defaultConfig.shortcuts!,
        ...(configService.getConfig().shortcuts ?? {}),
      };
      const shortcutAction = event.repeat
        ? null
        : resolveBrowserPanelShortcutAction(event, {
            terminal: shortcuts.terminal,
            browser: shortcuts.browser,
            'side-chat': shortcuts.sideChat,
            files: shortcuts.files,
            review: shortcuts.review,
          });
      if (shortcutAction) {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(`cowork:shortcut:${shortcutAction}`));
        return false;
      }
      const key = event.key.toLowerCase();
      const isMac = window.electron.platform === 'darwin';
      const primaryModifier = isMac ? event.metaKey : event.ctrlKey;
      const terminalClipboardModifier = isMac ? event.metaKey : event.ctrlKey && event.shiftKey;
      if (primaryModifier && key === 'f') {
        openSearch();
        return false;
      }
      if (terminalClipboardModifier && key === 'c' && terminal.hasSelection()) {
        const selection = terminal.getSelection();
        if (selection) ignoreTerminalActionFailure(navigator.clipboard.writeText(selection));
        return false;
      }
      if (terminalClipboardModifier && key === 'v') {
        void navigator.clipboard
          .readText()
          .then(text => {
            if (text) terminal.paste(text);
          })
          .catch(() => undefined);
        return false;
      }
      return true;
    });

    const createPromise =
      createPromiseRef.current ??
      window.electron.terminal
        .create({
          id: backendTerminalId,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => ({ success: false }) as const);
    createPromiseRef.current = createPromise;
    void createPromise.then(result => {
      if (disposed) return;
      if (!result.success) {
        terminal.write(`\r\n${i18nService.t('coworkTerminalCreateFailed')}\r\n`);
        return;
      }
      backendReadyRef.current = true;
      fitAndResize();
      terminal.focus();
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      searchResultSubscription.dispose();
      unsubscribeData();
      unsubscribeExit();
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      textarea?.removeEventListener('compositionstart', handleCompositionStart);
      textarea?.removeEventListener('compositionupdate', handleCompositionUpdate);
      textarea?.removeEventListener('compositionend', handleCompositionEnd);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      // Delay backend teardown by one task. React StrictMode immediately reruns
      // this effect in development, where the new run cancels this pending close
      // and reuses the same PTY instead of killing the just-created shell.
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        void createPromise.then(result => {
          if (result.success) {
            ignoreTerminalActionFailure(window.electron.terminal.close(backendTerminalId));
          }
          backendReadyRef.current = false;
          createPromiseRef.current = null;
        });
      }, 0);
    };
  }, [cwd, openSearch, terminalId]);

  useEffect(() => {
    if (isObscured) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // The shared display panel may still be measuring after becoming visible.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isObscured]);

  return (
    <section
      className={`${isObscured ? 'hidden' : 'flex'} absolute inset-0 min-h-0 flex-col bg-[#0c0c0c] p-2`}
      aria-label={i18nService.t('coworkTerminal')}
      aria-hidden={isObscured}
      onContextMenu={event => {
        event.preventDefault();
        setContextMenu({
          canCopy: terminalRef.current?.hasSelection() ?? false,
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
      {isSearchOpen && (
        <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-white/15 bg-[#181818] p-1 shadow-xl">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                find(event.shiftKey ? -1 : 1);
              }
            }}
            className="h-7 w-44 rounded border border-white/15 bg-black/30 px-2 text-xs text-white outline-none focus:border-[#3a96dd]"
            placeholder={i18nService.t('coworkTerminalFindPlaceholder')}
            aria-label={i18nService.t('coworkTerminalFindPlaceholder')}
          />
          <span className="min-w-12 text-center text-[11px] text-[#aaa]">
            {searchResult.total > 0 ? `${searchResult.index + 1}/${searchResult.total}` : '0/0'}
          </span>
          <button
            type="button"
            className="h-7 rounded px-2 text-xs text-[#ccc] hover:bg-white/10"
            onClick={() => find(-1)}
            title={i18nService.t('coworkTerminalFindPrevious')}
          >
            ↑
          </button>
          <button
            type="button"
            className="h-7 rounded px-2 text-xs text-[#ccc] hover:bg-white/10"
            onClick={() => find(1)}
            title={i18nService.t('coworkTerminalFindNext')}
          >
            ↓
          </button>
          <button
            type="button"
            className="h-7 rounded px-2 text-xs text-[#ccc] hover:bg-white/10"
            onClick={closeSearch}
            title={i18nService.t('close')}
          >
            ×
          </button>
        </div>
      )}
      {contextMenu && (
        <TerminalContextMenu
          canCopy={contextMenu.canCopy}
          x={contextMenu.x}
          y={contextMenu.y}
          onDismiss={() => {
            setContextMenu(null);
            requestAnimationFrame(focusTerminal);
          }}
          onCopy={copySelection}
          onPaste={pasteClipboard}
          onSelectAll={() => terminalRef.current?.selectAll()}
          onFind={openSearch}
          onClear={() => terminalRef.current?.clear()}
        />
      )}
    </section>
  );
};

export default TerminalPanel;
