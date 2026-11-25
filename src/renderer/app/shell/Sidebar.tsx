import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import { CoworkSessionExportFailure } from '@shared/cowork/sessionExport';
import type { CoworkSessionMessageSearchMatch } from '@shared/cowork/sessionSearch';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import { useAutomaticErrorRetryActivity } from '@/features/cowork/components/chat/useAutomaticErrorRetryActivity';
import {
  type FilePreviewNavigationOptions,
  runGuardedFilePreviewNavigation,
} from '@/features/cowork/components/preview/filePreviewNavigation';
import CoworkSearchModal from '@/features/cowork/components/sessions/CoworkSearchModal';
import CoworkSessionList from '@/features/cowork/components/sessions/CoworkSessionList';
import ExportSessionModal from '@/features/cowork/components/sessions/ExportSessionModal';
import { toggleVisibleSessionSelection } from '@/features/cowork/components/sessions/sessionSelection';
import { getSessionTranscriptActionError } from '@/features/cowork/components/sessions/useCoworkSessionActions';
import {
  selectCoworkSessions,
  selectCurrentSessionId,
  selectGroups,
  selectSessionDirectory,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import { requestCoworkSessionListAction } from '@/features/cowork/sessionListActions';
import { appBrowserRegistry } from '@/features/plugins/app/runtime';
import { i18nService } from '@/services/i18n';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Modal from '@/shared/components/ui/Modal';
import { store } from '@/store';

import NavigationRail from './NavigationRail';
import { SidebarView } from './sidebarNavigation';
import { useSessionListResize } from './useSessionListResize';

const exportFailureTranslation = {
  [CoworkSessionExportFailure.Running]: 'coworkExportWaitForCompletion',
  [CoworkSessionExportFailure.Unavailable]: 'coworkExportHistoryUnavailable',
  [CoworkSessionExportFailure.Changed]: 'coworkExportHistoryChanged',
  [CoworkSessionExportFailure.Failed]: 'coworkExportFailed',
};

interface SidebarProps {
  onShowSettings: () => void;
  activeView: SidebarView;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowWorkboard: () => void;
  showWorkboard: boolean;
  onShowMemory: () => void;
  onShowPlugins: () => void;
  onNewChat: () => void;
  onBeforeCoworkNavigation: (options?: FilePreviewNavigationOptions) => Promise<boolean>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onRevealSearchMatch?: (match: CoworkSessionMessageSearchMatch) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowCowork,
  onShowScheduledTasks,
  onShowWorkboard,
  showWorkboard,
  onShowMemory,
  onShowPlugins,
  onNewChat,
  onBeforeCoworkNavigation,
  isCollapsed,
  onToggleCollapse,
  onRevealSearchMatch,
}) => {
  const sessionNavigationRequestRef = useRef(0);
  const homePanelId = useId();
  // An unmounted sidebar no longer owns any pending navigation.
  useEffect(() => {
    return () => {
      sessionNavigationRequestRef.current += 1;
    };
  }, []);
  const sessions = useSelector(selectCoworkSessions);
  const directory = useSelector(selectSessionDirectory);
  const groups = useSelector(selectGroups);
  const sessionListStatus = useSelector(
    (state: import('@/store').RootState) => state.cowork.sessionListStatus,
  );
  const currentSessionId = useSelector(selectCurrentSessionId);
  const unreadScheduledTaskResults = useSelector(
    (state: import('@/store').RootState) => state.scheduledTask.unreadResultCount,
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<{ id: string; title: string } | null>(null);
  const exportTargetRetrying = useAutomaticErrorRetryActivity(exportTarget?.id);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [displayedSessionIds, setDisplayedSessionIds] = useState<string[]>([]);
  const handleVisibleSessionIdsChange = useCallback((ids: string[]) => {
    setDisplayedSessionIds(current =>
      current.length === ids.length && current.every((id, index) => id === ids[index])
        ? current
        : ids,
    );
  }, []);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const isHomePanelVisible = activeView === SidebarView.Home && !isCollapsed;
  const sessionListResize = useSessionListResize(isHomePanelVisible);

  useEffect(() => {
    const handleSearch = () => {
      sessionNavigationRequestRef.current += 1;
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (isHomePanelVisible) return;
    sessionNavigationRequestRef.current += 1;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, [isHomePanelVisible]);

  const handleSelectSession = async (
    sessionId: string,
    match?: CoworkSessionMessageSearchMatch,
  ) => {
    const requestId = ++sessionNavigationRequestRef.current;
    let selected = false;
    await runGuardedFilePreviewNavigation(
      onBeforeCoworkNavigation,
      async () => {
        if (requestId !== sessionNavigationRequestRef.current) return;
        onShowCowork();
        const target = appBrowserRegistry.sessionNavigation(sessionId);
        const loaded = await coworkService.loadSession(target.sessionId, {
          canSelect: () => requestId === sessionNavigationRequestRef.current && target.isCurrent(),
        });
        if (requestId !== sessionNavigationRequestRef.current || !loaded) return;
        selected = store.getState().cowork.currentSession?.id === target.sessionId;
        if (selected && match && target.sessionId === match.sessionId) onRevealSearchMatch?.(match);
        if (selected && target.isCurrent()) target.selected();
      },
      { preserveTabs: true },
    );
    return selected;
  };

  const handleDeleteSession = async (sessionId: string) => {
    const deleteSession = () => coworkService.deleteSession(sessionId);
    if (sessionId === currentSessionId) {
      await runGuardedFilePreviewNavigation(onBeforeCoworkNavigation, deleteSession);
      return;
    }
    await deleteSession();
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    const renamed = await coworkService.renameSession(sessionId, title).catch(() => false);
    if (!renamed) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkRenameFailed') }),
      );
    }
  };

  useSyncExternalStore(appBrowserRegistry.subscribe, appBrowserRegistry.getContextRevision);
  const visibleDirectory = directory.filter(session => {
    const anchor = appBrowserRegistry.sessionPresentation(session.id).anchorSessionId;
    if (anchor && anchor !== session.id) return false;
    return (
      Boolean(session.external) || (session.agentId || MAIN_USER_AGENT_ID) === MAIN_USER_AGENT_ID
    );
  });
  const visibleDirectoryIds = new Set(visibleDirectory.map(session => session.id));
  const visibleSessions = sessions.filter(session => visibleDirectoryIds.has(session.id));
  const handleCopySession = async (sessionId: string) => {
    const requestId = ++sessionNavigationRequestRef.current;
    await runGuardedFilePreviewNavigation(
      onBeforeCoworkNavigation,
      async () => {
        if (requestId !== sessionNavigationRequestRef.current) return;
        onShowCowork();
        const session = await coworkService.loadSession(sessionId, {
          canSelect: () => requestId === sessionNavigationRequestRef.current,
        });
        if (
          requestId === sessionNavigationRequestRef.current &&
          session &&
          store.getState().cowork.currentSession?.id === sessionId
        ) {
          requestCoworkSessionListAction({ action: 'copy', sessionId });
        }
      },
      { preserveTabs: true },
    );
  };

  const checkExportTarget = (sessionId: string): boolean => {
    const source = visibleDirectory.find(session => session.id === sessionId);
    const running =
      store.getState().cowork.sessionRuntimeActivity?.[sessionId] === true ||
      (source?.status === 'running' && !source.external?.readOnly) ||
      (exportTarget?.id === sessionId && exportTargetRetrying);
    const error = source
      ? getSessionTranscriptActionError('export', sessionId, running)
      : 'coworkExportHistoryUnavailable';
    if (!error) return true;
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t(error) }));
    return false;
  };

  const handleOpenExport = (sessionId: string) => {
    if (exportTarget) return;
    const source = visibleSessions.find(session => session.id === sessionId);
    if (source && checkExportTarget(sessionId)) setExportTarget({ id: sessionId, title: source.title });
  };

  const handleExport = async (includeRawData: boolean): Promise<boolean> => {
    if (!exportTarget || !checkExportTarget(exportTarget.id)) return false;
    try {
      const result = await window.electron.cowork.exportSession({
        sessionId: exportTarget.id,
        includeRawData,
      });
      if (result.success && result.canceled) return false;
      const toast = result.success ? 'coworkExportSuccess' : exportFailureTranslation[result.reason];
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t(toast) }));
      return result.success;
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkExportFailed') }),
      );
      return false;
    }
  };

  const handleEnterBatchMode = useCallback((sessionId: string) => {
    setIsBatchMode(true);
    setSelectedIds(new Set([sessionId]));
  }, []);

  const handleExitBatchMode = useCallback(() => {
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, []);

  const handleToggleSelection = useCallback((sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const visibleSessionIds = displayedSessionIds.filter(id => visibleDirectoryIds.has(id));
  const visibleSelection = new Set([...selectedIds].filter(id => visibleSessionIds.includes(id)));
  const handleSelectAll = () =>
    setSelectedIds(previous => toggleVisibleSessionSelection(previous, visibleSessionIds));

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowBatchDeleteConfirm(true);
  }, [selectedIds.size]);

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds).filter(id => visibleSessionIds.includes(id));
    if (ids.length === 0) return;
    const deleteSessions = async () => {
      await coworkService.deleteSessions(ids);
      handleExitBatchMode();
    };
    if (currentSessionId && ids.includes(currentSessionId)) {
      await runGuardedFilePreviewNavigation(onBeforeCoworkNavigation, deleteSessions);
      return;
    }
    await deleteSessions();
  };

  const navigateFromRail = (navigate: () => void) => {
    sessionNavigationRequestRef.current += 1;
    setIsSearchOpen(false);
    navigate();
  };

  return (
    <>
      <NavigationRail
        activeView={activeView}
        homePanelId={homePanelId}
        isHomePanelExpanded={isHomePanelVisible}
        showWorkboard={showWorkboard}
        unreadScheduledTaskResults={unreadScheduledTaskResults}
        onShowHome={() => {
          navigateFromRail(onShowCowork);
          if (activeView === SidebarView.Home || isCollapsed) onToggleCollapse();
        }}
        onShowScheduledTasks={() => navigateFromRail(onShowScheduledTasks)}
        onShowPlugins={() => navigateFromRail(onShowPlugins)}
        onShowMemory={() => navigateFromRail(onShowMemory)}
        onShowWorkboard={() => navigateFromRail(onShowWorkboard)}
        onShowSettings={() => navigateFromRail(onShowSettings)}
      />
      <aside
        ref={sessionListResize.panelRef}
        id={homePanelId}
        aria-label={i18nService.t('sidebarHome')}
        hidden={!isHomePanelVisible}
        style={{ width: sessionListResize.width }}
        className={`relative col-start-2 row-start-2 min-w-0 min-h-0 shrink-0 flex-col pr-1.5 border-r border-border bg-[var(--shell-sidebar-bg)] overflow-hidden ${isHomePanelVisible ? 'flex' : 'hidden'}`}
      >
        <div
          role="separator"
          aria-label={i18nService.t('sidebarResizeSessions')}
          aria-orientation="vertical"
          aria-controls={homePanelId}
          aria-valuemin={sessionListResize.minWidth}
          aria-valuemax={sessionListResize.maxWidth}
          aria-valuenow={sessionListResize.width}
          tabIndex={isHomePanelVisible ? 0 : -1}
          onPointerDown={sessionListResize.beginResize}
          onKeyDown={sessionListResize.handleKeyDown}
          className="non-draggable absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
        />
        {sessionListStatus !== 'loading' && (
          <div className="px-2.5 pt-2 pb-1.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => navigateFromRail(onNewChat)}
                className={`relative min-w-0 flex-1 inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
                  activeView === SidebarView.Home
                    ? 'text-primary hover:bg-surface'
                    : 'text-secondary hover:text-foreground hover:bg-surface'
                }`}
              >
                <ComposeIcon className="h-4 w-4" />
                {i18nService.t('newChat')}
              </button>
              <button
                type="button"
                onClick={() => {
                  sessionNavigationRequestRef.current += 1;
                  onShowCowork();
                  setIsSearchOpen(true);
                }}
                className="non-draggable h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
                aria-label={i18nService.t('search')}
                title={i18nService.t('search')}
              >
                <SearchIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2.5 pb-4">
          <CoworkSessionList
            groupRecentSessionsByDate
            sessions={visibleSessions}
            directory={visibleDirectory}
            workspaceDirectory={directory}
            onVisibleSessionIdsChange={handleVisibleSessionIdsChange}
            isLoading={sessionListStatus === 'loading'}
            loadFailed={sessionListStatus === 'error'}
            currentSessionId={
              appBrowserRegistry.sessionPresentation(currentSessionId || '').anchorSessionId ||
              currentSessionId
            }
            isBatchMode={isBatchMode}
            selectedIds={visibleSelection}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
            onExportSession={handleOpenExport}
            onCopySession={sessionId => void handleCopySession(sessionId)}
            onToggleSelection={handleToggleSelection}
            onEnterBatchMode={handleEnterBatchMode}
          />
        </div>
        {isBatchMode ? (
          <div className="px-3 pb-3 pt-1 flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-secondary">
              <input
                type="checkbox"
                checked={
                  visibleSessionIds.length > 0 && visibleSessionIds.every(id => selectedIds.has(id))
                }
                onChange={handleSelectAll}
                className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-primary cursor-pointer"
              />
              {i18nService.t('batchSelectAll')}
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleBatchDeleteClick}
                disabled={visibleSelection.size === 0}
                className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  visibleSelection.size > 0
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                }`}
              >
                <TrashIcon className="h-3.5 w-3.5" />
                {visibleSelection.size > 0 ? `${visibleSelection.size}` : ''}
              </button>
              <button
                type="button"
                onClick={handleExitBatchMode}
                className="px-3 py-1.5 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('batchCancel')}
              </button>
            </div>
          </div>
        ) : null}
        {/* Batch Delete Confirmation Modal */}
        {showBatchDeleteConfirm && (
          <Modal
            onClose={() => setShowBatchDeleteConfirm(false)}
            className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                {i18nService.t('batchDeleteConfirmTitle')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm text-secondary">
                {i18nService
                  .t('batchDeleteConfirmMessage')
                  .replace('{count}', String(visibleSelection.size))}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleBatchDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('batchDelete')} ({visibleSelection.size})
              </button>
            </div>
          </Modal>
        )}
      </aside>
      <ExportSessionModal
        isOpen={exportTarget !== null}
        sessionTitle={exportTarget?.title ?? ''}
        onClose={() => setExportTarget(null)}
        onExport={handleExport}
      />
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={visibleSessions}
        scopeSessionIds={visibleDirectory.map(session => session.id)}
        groups={groups}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
      />
    </>
  );
};

export default Sidebar;
