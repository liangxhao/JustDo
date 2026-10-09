import './CoworkDisplayPanel.css';

import { ChevronDownIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import FileTreeIcon from '@/shared/components/icons/FileTreeIcon';
import RightSidebarIcon from '@/shared/components/icons/RightSidebarIcon';
import WorkspaceFullscreenIcon from '@/shared/components/icons/WorkspaceFullscreenIcon';

import DisplayTabContextMenu, { type DisplayTabContextMenuItem } from './DisplayTabContextMenu';
import { FILE_DISPLAY_TAB_PREFIX, WORKSPACE_FILES_DISPLAY_TAB_ID } from './displayTabIds';
import DisplayTabListMenu from './DisplayTabListMenu';
import FilePathBreadcrumbBar from './FilePathBreadcrumbBar';
import { FilePreviewToolbarContext } from './FilePreviewToolbarContext';
import useDisplayTabLayout from './useDisplayTabLayout';

export interface CoworkDisplayTab {
  id: string;
  label: string;
  icon: React.ReactNode;
  contextMenuItems?: DisplayTabContextMenuItem[];
  onClose?: () => void | boolean | Promise<void | boolean>;
  onContextMenu?: (
    position: { x: number; y: number },
    closeActions: CoworkDisplayTabCloseActions,
  ) => void;
  onSelect: () => void;
}

export interface CoworkDisplayTabCloseActions {
  canCloseOthers: boolean;
  canCloseRight: boolean;
  close: () => Promise<void>;
  closeOthers: () => Promise<void>;
  closeRight: () => Promise<void>;
  restoreFocus: () => void;
}

interface CoworkDisplayPanelProps {
  activeTabId: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  emptyState?: React.ReactNode;
  fileContextPath?: string;
  workspacePath?: string;
  isOpen: boolean;
  onClose: () => void;
  onWidthChange?: (width: number) => void;
  onSidePanelClose?: () => void;
  onSidePanelToggle?: () => void;
  sidePanel?: React.ReactNode;
  sidePanelVisible?: boolean;
  showEmptyState?: boolean;
  tabs: CoworkDisplayTab[];
  width?: number;
}

const DISPLAY_PANEL_DEFAULT_WIDTH = 520;
const DISPLAY_PANEL_MIN_WIDTH = 360;
const CHAT_PANEL_MIN_WIDTH = 360;
const SIDE_PANEL_MIN_WIDTH = 160;
const SIDE_PANEL_COLLAPSE_WIDTH = 80;
const PREVIEW_CONTENT_MIN_WIDTH = 180;

const getDisplayPanelMaxWidth = (element: HTMLElement | null): number => {
  const availableWidth = element?.parentElement?.clientWidth ?? window.innerWidth;
  return Math.max(DISPLAY_PANEL_MIN_WIDTH, availableWidth - CHAT_PANEL_MIN_WIDTH);
};

const CoworkDisplayPanel: React.FC<CoworkDisplayPanelProps> = ({
  activeTabId,
  actions,
  children,
  emptyState,
  fileContextPath,
  workspacePath,
  isOpen,
  onClose,
  onWidthChange,
  onSidePanelClose,
  onSidePanelToggle,
  sidePanel,
  sidePanelVisible = Boolean(sidePanel),
  tabs,
  showEmptyState = tabs.length === 0,
  width: controlledWidth,
}) => {
  const activeFilePath =
    fileContextPath ||
    (activeTabId.startsWith(FILE_DISPLAY_TAB_PREFIX)
      ? activeTabId.slice(FILE_DISPLAY_TAB_PREFIX.length)
      : undefined);
  const [uncontrolledWidth, setUncontrolledWidth] = useState(DISPLAY_PANEL_DEFAULT_WIDTH);
  const configuredWidth = controlledWidth ?? uncontrolledWidth;
  const [automaticWidth, setAutomaticWidth] = useState(() => window.innerWidth / 2);
  const width = configuredWidth === 0 ? automaticWidth : configuredWidth;
  const widthRef = useRef(width);
  widthRef.current = width;
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;
  const [isWorkspaceFullscreen, setIsWorkspaceFullscreen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const hasSidePanel = Boolean(sidePanel) && sidePanelVisible;
  const [hasOpenedSidePanel, setHasOpenedSidePanel] = useState(hasSidePanel);
  const [isSidePanelResizing, setIsSidePanelResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const sidePanelRef = useRef<HTMLDivElement>(null);
  const sidePanelToggleRef = useRef<HTMLButtonElement>(null);
  const [fileToolbarTarget, setFileToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [contentWidth, setContentWidth] = useState(width);
  const [requestedSidePanelWidth, setRequestedSidePanelWidth] = useState<number | null>(null);
  const sidePanelMaxWidth = Math.max(
    SIDE_PANEL_MIN_WIDTH,
    contentWidth - PREVIEW_CONTENT_MIN_WIDTH,
  );
  const sidePanelWidth = Math.min(
    Math.max(requestedSidePanelWidth ?? contentWidth * 0.42, SIDE_PANEL_MIN_WIDTH),
    sidePanelMaxWidth,
  );
  const sidePanelCloseRef = useRef(onSidePanelClose);
  sidePanelCloseRef.current = onSidePanelClose;
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const tabListButtonRef = useRef<HTMLButtonElement>(null);
  const tabListMenuId = useId();
  const [tabListOpen, setTabListOpen] = useState(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const { clusterRef, scrollerRef, actionsRef, tabWidth, hasOverflow, revealTab } =
    useDisplayTabLayout({
      hasActions: Boolean(actions),
      activeTabId,
      isOpen,
      isWorkspaceFullscreen,
      tabCount: tabs.length,
      tabButtonRefs,
      width,
    });

  useLayoutEffect(() => {
    if (!tabListOpen || (isOpen && hasOverflow && tabs.length)) return;
    setTabListOpen(false);
    if (isOpen) {
      tabButtonRefs.current.get(activeTabId)?.focus({ preventScroll: true });
    }
  }, [activeTabId, hasOverflow, isOpen, tabListOpen, tabs.length]);

  const clampWidth = useCallback((nextWidth: number) => {
    return Math.min(
      Math.max(nextWidth, DISPLAY_PANEL_MIN_WIDTH),
      getDisplayPanelMaxWidth(panelRef.current),
    );
  }, []);

  const setWidth = useCallback((value: number | ((current: number) => number)) => {
    const nextWidth = typeof value === 'function' ? value(widthRef.current) : value;
    if (Object.is(widthRef.current, nextWidth)) return;
    widthRef.current = nextWidth;
    setUncontrolledWidth(nextWidth);
    onWidthChangeRef.current?.(nextWidth);
  }, []);

  useEffect(() => {
    const resize = () => {
      if (configuredWidth === 0) {
        const availableWidth = panelRef.current?.parentElement?.clientWidth;
        if (availableWidth) setAutomaticWidth(clampWidth(availableWidth / 2));
      } else {
        setWidth(current => clampWidth(current));
      }
    };
    resize();
    const container = panelRef.current?.parentElement;
    const observer =
      container && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (container) observer?.observe(container);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [clampWidth, configuredWidth, setWidth]);

  useEffect(() => {
    if (!hasSidePanel) return;
    setWidth(current => clampWidth(Math.max(current, 760)));
  }, [clampWidth, hasSidePanel, setWidth]);

  useEffect(() => {
    if (!isOpen) setTabMenu(null);
  }, [isOpen]);

  useEffect(() => {
    const panel = panelRef.current;
    const measure = () => setContentWidth(panel?.clientWidth || width);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (panel) observer?.observe(panel);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [width, isWorkspaceFullscreen, isOpen]);

  useEffect(() => {
    if (!hasSidePanel || !isOpen) resizeCleanupRef.current?.();
  }, [hasSidePanel, isOpen]);

  useEffect(() => {
    if (hasSidePanel) setHasOpenedSidePanel(true);
  }, [hasSidePanel]);

  useLayoutEffect(() => {
    const panel = sidePanelRef.current;
    const isInteractive = hasSidePanel && isOpen;
    if (!isInteractive && panel?.contains(document.activeElement)) {
      sidePanelToggleRef.current?.focus();
    }
    panel?.toggleAttribute('inert', !isInteractive);
  }, [hasSidePanel, hasOpenedSidePanel, isOpen]);

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !tabs.length) return;
      event.preventDefault();
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : event.key === 'ArrowLeft'
              ? (tabIndex - 1 + tabs.length) % tabs.length
              : (tabIndex + 1) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      nextTab.onSelect();
      requestAnimationFrame(() => {
        revealTab(nextTab.id);
        tabButtonRefs.current.get(nextTab.id)?.focus({ preventScroll: true });
      });
    },
    [revealTab, tabs],
  );

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      event.preventDefault();

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setWidth(clampWidth(right - moveEvent.clientX));
      };
      const cleanupResize = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', cleanupResize);
        resizeCleanupRef.current = null;
      };

      resizeCleanupRef.current?.();
      resizeCleanupRef.current = cleanupResize;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', cleanupResize);
    },
    [clampWidth, setWidth],
  );

  const beginSidePanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const right = sidePanelRef.current?.getBoundingClientRect().right;
    if (right === undefined) return;
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const cleanupResize = () => {
      setIsSidePanelResizing(false);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('blur', cleanupResize);
      resizeCleanupRef.current = null;
    };
    const finishResize = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) cleanupResize();
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextWidth = right - moveEvent.clientX;
      if (nextWidth <= SIDE_PANEL_COLLAPSE_WIDTH && sidePanelCloseRef.current) {
        cleanupResize();
        sidePanelCloseRef.current();
        return;
      }
      setRequestedSidePanelWidth(
        Math.min(Math.max(nextWidth, SIDE_PANEL_MIN_WIDTH), sidePanelMaxWidth),
      );
    };
    resizeCleanupRef.current = cleanupResize;
    setIsSidePanelResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.setPointerCapture?.(pointerId);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('blur', cleanupResize);
  };

  const closeTabs = useCallback(async (closingTabs: CoworkDisplayTab[]): Promise<boolean> => {
    for (const tab of closingTabs) {
      if ((await tab.onClose?.()) === false) return false;
    }
    return true;
  }, []);

  const focusTab = useCallback(
    (tabId: string | undefined) => {
      if (!tabId) return;
      requestAnimationFrame(() => {
        revealTab(tabId);
        tabButtonRefs.current.get(tabId)?.focus({ preventScroll: true });
      });
    },
    [revealTab],
  );

  const getCloseActions = useCallback(
    (tab: CoworkDisplayTab, tabIndex: number): CoworkDisplayTabCloseActions => {
      const otherTabs = tabs.filter(candidate => candidate.id !== tab.id && candidate.onClose);
      const rightTabs = tabs.slice(tabIndex + 1).filter(candidate => candidate.onClose);
      const adjacentTab = tabs[tabIndex + 1] ?? tabs[tabIndex - 1];
      return {
        canCloseOthers: otherTabs.length > 0,
        canCloseRight: rightTabs.length > 0,
        close: async () => {
          const closed = (await tab.onClose?.()) !== false;
          focusTab(closed ? adjacentTab?.id : tab.id);
        },
        closeOthers: async () => {
          tab.onSelect();
          await closeTabs(otherTabs);
          focusTab(tab.id);
        },
        closeRight: async () => {
          await closeTabs(rightTabs);
          focusTab(tab.id);
        },
        restoreFocus: () => focusTab(tab.id),
      };
    },
    [closeTabs, focusTab, tabs],
  );

  const menuTabIndex = tabMenu ? tabs.findIndex(tab => tab.id === tabMenu.tabId) : -1;
  const menuTab = menuTabIndex >= 0 ? tabs[menuTabIndex] : undefined;
  const menuCloseActions = menuTab ? getCloseActions(menuTab, menuTabIndex) : undefined;
  const showFileToolbar = Boolean(
    activeFilePath || activeTabId === WORKSPACE_FILES_DISPLAY_TAB_ID || hasSidePanel,
  );
  const workspaceLabel =
    workspacePath?.match(/^[A-Za-z]:/)?.[0] ??
    workspacePath
      ?.split(/[\\/]+/)
      .filter(Boolean)
      .pop();

  const dismissTabMenu = (restoreFocus = true) => {
    const triggerTabId = tabMenu?.tabId;
    setTabMenu(null);
    if (restoreFocus) focusTab(triggerTabId);
  };

  const dismissTabList = (restoreFocus = true) => {
    setTabListOpen(false);
    if (restoreFocus) tabListButtonRef.current?.focus({ preventScroll: true });
  };

  return (
    <aside
      id="cowork-display-panel"
      ref={panelRef}
      className={`${isOpen ? 'flex' : 'hidden'} cowork-display-panel absolute inset-y-0 right-0 z-50 max-w-[calc(100%-2rem)] flex-col border-l border-border bg-background shadow-xl`}
      style={
        isWorkspaceFullscreen
          ? { width: '100%', maxWidth: 'none', position: 'absolute', inset: 0, zIndex: 50 }
          : ({ width, '--display-panel-width': `${width}px` } as React.CSSProperties)
      }
      aria-label={i18nService.t('coworkCanvasTitle')}
      aria-hidden={!isOpen}
      {...(!isOpen ? { inert: '' } : {})}
      data-workspace-fullscreen={isWorkspaceFullscreen}
    >
      <div
        className={`${isWorkspaceFullscreen ? '!hidden' : ''} cowork-display-panel-resizer absolute inset-y-0 left-0 z-[90] hidden w-5 -translate-x-1/2 touch-none cursor-col-resize`}
        onPointerDown={beginResize}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setWidth(current => clampWidth(current + (event.key === 'ArrowLeft' ? 24 : -24)));
        }}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={i18nService.t('resizePanels')}
        aria-valuemin={DISPLAY_PANEL_MIN_WIDTH}
        aria-valuemax={getDisplayPanelMaxWidth(panelRef.current)}
        aria-valuenow={Math.round(width)}
      />

      <div
        className={`cowork-workspace-header cowork-display-tabs-header relative z-20 flex shrink-0 items-stretch px-2 ${tabs.length ? 'bg-surface' : 'bg-background'}`}
      >
        <div
          ref={clusterRef}
          className="flex h-full min-w-0 flex-1 items-stretch"
          data-testid="display-tab-cluster"
        >
          <div
            ref={scrollerRef}
            className={`${tabs.length > 0 ? 'flex' : 'hidden'} cowork-display-tab-scroller h-full min-w-0 items-stretch`}
            style={{ width: tabs.length * tabWidth }}
            role={tabs.length > 0 ? 'tablist' : undefined}
            aria-label={tabs.length > 0 ? i18nService.t('coworkCanvasTitle') : undefined}
          >
            {tabs.map((tab, tabIndex) => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className="group cowork-display-tab flex h-full min-w-0 shrink-0 items-center px-2"
                  style={{ width: tabWidth }}
                  data-active={isActive}
                  onContextMenu={
                    tab.onContextMenu
                      ? event => {
                          event.preventDefault();
                          setTabListOpen(false);
                          setTabMenu(null);
                          const rect = event.currentTarget.getBoundingClientRect();
                          const position =
                            event.clientX || event.clientY
                              ? { x: event.clientX, y: event.clientY }
                              : { x: rect.left, y: rect.bottom };
                          tab.onContextMenu?.(position, getCloseActions(tab, tabIndex));
                        }
                      : event => {
                          event.preventDefault();
                          setTabListOpen(false);
                          const rect = event.currentTarget.getBoundingClientRect();
                          setTabMenu({
                            tabId: tab.id,
                            x: event.clientX || event.clientY ? event.clientX : rect.left,
                            y: event.clientX || event.clientY ? event.clientY : rect.bottom,
                          });
                        }
                  }
                >
                  <button
                    ref={element => {
                      if (element) tabButtonRefs.current.set(tab.id, element);
                      else tabButtonRefs.current.delete(tab.id);
                    }}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    onClick={tab.onSelect}
                    onKeyDown={event => handleTabKeyDown(event, tabIndex)}
                    className="cowork-display-tab-select flex h-full min-w-0 flex-1 items-center gap-1.5 text-xs font-medium"
                    title={tab.label}
                  >
                    <span className="h-4 w-4 shrink-0" aria-hidden="true">
                      {tab.icon}
                    </span>
                    <span className="min-w-0 truncate">{tab.label}</span>
                  </button>
                  {tab.onClose && (
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        tab.onClose?.();
                      }}
                      className="cowork-display-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-70 hover:bg-surface-overlay hover:text-foreground group-hover:opacity-100"
                      aria-label={`${i18nService.t('close')}: ${tab.label}`}
                      title={i18nService.t('close')}
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {tabs.length > 0 && actions && (
            <div ref={actionsRef} className="flex h-full shrink-0 items-center">
              {actions}
            </div>
          )}
          {tabs.length > 0 && hasOverflow && (
            <button
              ref={tabListButtonRef}
              type="button"
              className="cowork-display-tab-list-button inline-flex h-7 w-8 shrink-0 self-center items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              aria-label={i18nService.t('coworkDisplayTabList')}
              title={i18nService.t('coworkDisplayTabList')}
              aria-haspopup="menu"
              aria-expanded={tabListOpen}
              aria-controls={tabListOpen ? tabListMenuId : undefined}
              onClick={() => {
                setTabMenu(null);
                setTabListOpen(open => !open);
              }}
            >
              <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setIsWorkspaceFullscreen(fullscreen => !fullscreen)}
          className="inline-flex h-7 w-8 shrink-0 self-center items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          title={i18nService.t(
            isWorkspaceFullscreen
              ? 'coworkDisplayPanelExitFullscreen'
              : 'coworkDisplayPanelFullscreen',
          )}
          aria-label={i18nService.t(
            isWorkspaceFullscreen
              ? 'coworkDisplayPanelExitFullscreen'
              : 'coworkDisplayPanelFullscreen',
          )}
          aria-pressed={isWorkspaceFullscreen}
        >
          <WorkspaceFullscreenIcon className="h-4 w-4" expanded={isWorkspaceFullscreen} />
        </button>
        <button
          type="button"
          onClick={() => {
            setIsWorkspaceFullscreen(false);
            onClose();
          }}
          className="inline-flex h-7 w-8 shrink-0 self-center items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          title={i18nService.t('coworkDisplayPanelClose')}
          aria-label={i18nService.t('coworkDisplayPanelClose')}
        >
          <RightSidebarIcon className="h-4 w-4" />
        </button>
      </div>

      {showFileToolbar && (
        <div
          className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2"
          role="toolbar"
          aria-label={i18nService.t('coworkWorkspaceFileInfo')}
        >
          {activeFilePath ? (
            <FilePathBreadcrumbBar
              key={activeFilePath}
              filePath={activeFilePath}
              workspacePath={workspacePath}
              isVisible={isOpen}
            />
          ) : workspaceLabel ? (
            <div
              className="inline-flex h-8 min-w-8 max-w-48 items-center justify-center rounded-full bg-surface-raised px-2 text-xs font-medium text-foreground"
              title={workspacePath}
              aria-label={workspacePath}
            >
              <span className="truncate">{workspaceLabel}</span>
            </div>
          ) : null}
          <div ref={setFileToolbarTarget} className="flex shrink-0 items-center" />
          {sidePanel && onSidePanelToggle && (
            <button
              ref={sidePanelToggleRef}
              type="button"
              onClick={onSidePanelToggle}
              className={`ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
                hasSidePanel
                  ? 'border-primary/25 bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-surface-raised text-secondary hover:border-primary/40 hover:text-primary'
              }`}
              title={i18nService.t(
                hasSidePanel ? 'coworkWorkspaceFilesHide' : 'coworkWorkspaceFilesShow',
              )}
              aria-label={i18nService.t(
                hasSidePanel ? 'coworkWorkspaceFilesHide' : 'coworkWorkspaceFilesShow',
              )}
              aria-expanded={hasSidePanel}
              aria-controls="cowork-workspace-files-panel"
            >
              <FileTreeIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      <FilePreviewToolbarContext.Provider value={fileToolbarTarget}>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="relative min-w-0 flex-1 overflow-hidden">
            {children}
            {showEmptyState && emptyState && (
              <div className="absolute inset-0 z-10">{emptyState}</div>
            )}
          </div>
          {sidePanel && (
            <div
              id="cowork-workspace-files-panel"
              ref={sidePanelRef}
              className={`relative min-h-0 shrink-0 overflow-clip motion-reduce:transition-none ${hasSidePanel ? 'border-l border-border' : 'border-l-0'} ${isSidePanelResizing ? '' : 'transition-[width] duration-200 ease-out'}`}
              style={{ width: hasSidePanel ? sidePanelWidth : 0 }}
              aria-hidden={!hasSidePanel}
            >
              <div
                className={`absolute inset-y-0 left-0 z-30 w-3 touch-none cursor-col-resize transition-colors hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none ${hasSidePanel ? '' : 'pointer-events-none'}`}
                onPointerDown={beginSidePanelResize}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  if (
                    onSidePanelClose &&
                    (event.key === 'Home' ||
                      (event.key === 'ArrowRight' && sidePanelWidth <= SIDE_PANEL_MIN_WIDTH))
                  ) {
                    onSidePanelClose();
                    return;
                  }
                  const nextWidth =
                    event.key === 'Home'
                      ? SIDE_PANEL_MIN_WIDTH
                      : event.key === 'End'
                        ? sidePanelMaxWidth
                        : sidePanelWidth + (event.key === 'ArrowLeft' ? 24 : -24);
                  setRequestedSidePanelWidth(
                    Math.min(Math.max(nextWidth, SIDE_PANEL_MIN_WIDTH), sidePanelMaxWidth),
                  );
                }}
                role="separator"
                tabIndex={hasSidePanel ? 0 : -1}
                aria-orientation="vertical"
                aria-label={i18nService.t('coworkWorkspaceFilesResize')}
                title={i18nService.t('coworkWorkspaceFilesResize')}
                aria-valuemin={onSidePanelClose ? 0 : SIDE_PANEL_MIN_WIDTH}
                aria-valuemax={sidePanelMaxWidth}
                aria-valuenow={Math.round(sidePanelWidth)}
              />
              {(hasSidePanel || hasOpenedSidePanel) && (
                <div
                  className={`h-full motion-reduce:transition-none ${isSidePanelResizing ? '' : 'transition-[transform,opacity] duration-200 ease-out'}`}
                  style={{
                    width: sidePanelWidth,
                    transform: hasSidePanel ? 'translateX(0)' : 'translateX(100%)',
                    opacity: hasSidePanel ? 1 : 0,
                  }}
                >
                  {sidePanel}
                </div>
              )}
            </div>
          )}
        </div>
      </FilePreviewToolbarContext.Provider>
      {isOpen && hasOverflow && tabListOpen && tabListButtonRef.current && (
        <DisplayTabListMenu
          id={tabListMenuId}
          activeTabId={activeTabId}
          anchor={tabListButtonRef.current}
          tabs={tabs}
          onDismiss={dismissTabList}
          onSelect={tab => {
            dismissTabList(false);
            tab.onSelect();
            requestAnimationFrame(() => focusTab(activeTabIdRef.current));
          }}
        />
      )}
      {isOpen && tabMenu && menuTab && menuCloseActions && (
        <DisplayTabContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={menuTab.contextMenuItems}
          canClose={Boolean(menuTab.onClose)}
          canCloseOthers={menuCloseActions.canCloseOthers}
          canCloseRight={menuCloseActions.canCloseRight}
          onActionComplete={() => focusTab(menuTab.id)}
          onDismiss={dismissTabMenu}
          onClose={menuCloseActions.close}
          onCloseOthers={menuCloseActions.closeOthers}
          onCloseRight={menuCloseActions.closeRight}
        />
      )}
    </aside>
  );
};

export default CoworkDisplayPanel;
