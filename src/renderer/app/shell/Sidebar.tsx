import { BookOpenIcon, ExclamationTriangleIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { useCollaborationRooms } from '@/features/cowork/components/chat/CollaborationPanel';
import {
  type FilePreviewNavigationOptions,
  runGuardedFilePreviewNavigation,
} from '@/features/cowork/components/preview/filePreviewNavigation';
import {
  resolveCollaborationNavigation,
  toggleVisibleSessionSelection,
} from '@/features/cowork/components/sessions/collaborationNavigation';
import CoworkSearchModal from '@/features/cowork/components/sessions/CoworkSearchModal';
import CoworkSessionList from '@/features/cowork/components/sessions/CoworkSessionList';
import {
  selectCoworkSessions,
  selectCurrentSessionId,
  selectIsOpenClawEngine,
} from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import {
  type CoworkSessionListAction,
  requestCoworkSessionListAction,
} from '@/features/cowork/sessionListActions';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ArrowUpRightIcon from '@/shared/components/icons/ArrowUpRightIcon';
import ClockIcon from '@/shared/components/icons/ClockIcon';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import PuzzleIcon from '@/shared/components/icons/PuzzleIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import { store } from '@/store';

interface SidebarProps {
  onShowSettings: () => void;
  activeView: 'cowork' | 'scheduledTasks' | 'workboard' | 'memory' | 'plugins';
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
}) => {
  const sessionNavigationRequestRef = useRef(0);
  const sessions = useSelector(selectCoworkSessions);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const unreadScheduledTaskResults = useSelector(
    (state: import('@/store').RootState) => state.scheduledTask.unreadResultCount,
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [developerMode, setDeveloperMode] = useState(
    () => configService.getConfig().developerMode ?? false,
  );
  const isMac = window.electron.platform === 'darwin';

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, [isCollapsed]);

  useEffect(() => {
    const syncDeveloperMode = () => {
      setDeveloperMode(configService.getConfig().developerMode ?? false);
    };

    window.addEventListener('config-updated', syncDeveloperMode);
    return () => {
      window.removeEventListener('config-updated', syncDeveloperMode);
    };
  }, []);

  const handleSelectSession = async (sessionId: string) => {
    const requestId = ++sessionNavigationRequestRef.current;
    await runGuardedFilePreviewNavigation(
      onBeforeCoworkNavigation,
      async () => {
        if (requestId !== sessionNavigationRequestRef.current) return;
        onShowCowork();
        const target = resolveCollaborationNavigation(sessionId, collaborationRooms);
        const loaded = await coworkService.loadSession(target.sessionId);
        if (
          requestId === sessionNavigationRequestRef.current &&
          loaded &&
          target.memberSessionId &&
          store.getState().cowork.currentSession?.id === target.sessionId
        ) {
          requestCoworkSessionListAction({ action: 'collaboration', ...target });
        }
      },
      { preserveTabs: true },
    );
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
    await coworkService.renameSession(sessionId, title);
  };

  const collaborationRooms = useCollaborationRooms();
  const collaborationAnchors = new Map(
    collaborationRooms.flatMap(room =>
      room.members.map(member => [member.sessionId, room.anchorSessionId] as const),
    ),
  );
  const visibleSessions = sessions.filter(session => {
    const anchor = collaborationAnchors.get(session.id);
    if (anchor && anchor !== session.id) return false;
    return (
      Boolean(session.external) || (session.agentId || MAIN_USER_AGENT_ID) === MAIN_USER_AGENT_ID
    );
  });
  const handleSessionListAction = async (sessionId: string, action: CoworkSessionListAction) => {
    const requestId = ++sessionNavigationRequestRef.current;
    await runGuardedFilePreviewNavigation(
      onBeforeCoworkNavigation,
      async () => {
        if (requestId !== sessionNavigationRequestRef.current) return;
        onShowCowork();
        const session = await coworkService.loadSession(sessionId);
        if (
          requestId === sessionNavigationRequestRef.current &&
          session &&
          store.getState().cowork.currentSession?.id === sessionId
        ) {
          requestCoworkSessionListAction({ action, sessionId });
        }
      },
      { preserveTabs: true },
    );
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

  const visibleSessionIds = visibleSessions.map(session => session.id);
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

  const handleOpenChatWeb = async () => {
    try {
      // Defensive check: ensure openclaw engine API is available
      if (
        !window.electron?.openclaw?.engine?.getPort ||
        !window.electron?.openclaw?.engine?.getToken
      ) {
        console.warn('[Sidebar] OpenClaw engine API not available');
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }),
        );
        return;
      }

      const portResult = await window.electron.openclaw.engine.getPort();
      const tokenResult = await window.electron.openclaw.engine.getToken();

      const port = portResult.success ? portResult.port : null;
      const token = tokenResult.success ? tokenResult.token : null;

      if (!port) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('chatWebPortError') }),
        );
        return;
      }

      if (!token) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('chatWebTokenError') }),
        );
        return;
      }

      const url = `http://127.0.0.1:${port}/#token=${token}`;
      await window.electron.shell.openExternal(url);
    } catch (error) {
      console.error('[Sidebar] Failed to open ChatWeb:', error);
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('coworkErrorEngineNotReady') }),
      );
    }
  };

  return (
    <aside
      className={`shrink-0 bg-surface-raised flex flex-col sidebar-transition overflow-hidden ${
        isCollapsed ? 'w-0' : 'w-60'
      }`}
    >
      <div className="pt-3 pb-3">
        <div className="draggable sidebar-header-drag h-8 flex items-center justify-between px-3">
          <div className={`flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
            <button
              type="button"
              onClick={() => {
                onShowCowork();
                setIsSearchOpen(true);
              }}
              className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
              aria-label={i18nService.t('search')}
            >
              <SearchIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setIsSearchOpen(false);
                onShowMemory();
              }}
              className={`non-draggable inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                activeView === 'memory'
                  ? 'bg-primary/10 text-primary'
                  : 'text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
              aria-label={i18nService.t('memoryTitle')}
              title={i18nService.t('memoryTitle')}
            >
              <BookOpenIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            {developerMode && isOpenClawEngine && (
              <button
                type="button"
                onClick={handleOpenChatWeb}
                className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
                aria-label={i18nService.t('openChatWeb')}
                title={i18nService.t('openChatWeb')}
              >
                <ArrowUpRightIcon className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleCollapse}
              className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
            >
              <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-1 px-3">
          <button
            type="button"
            onClick={onNewChat}
            className={`relative w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'cowork'
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
              setIsSearchOpen(false);
              onShowScheduledTasks();
            }}
            aria-label={`${i18nService.t('scheduledTasks')}${
              unreadScheduledTaskResults
                ? `, ${unreadScheduledTaskResults} ${i18nService.t('scheduledTasksResultsUnreadLabel')}`
                : ''
            }`}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scheduledTasks'
                ? 'text-primary hover:bg-surface'
                : 'text-secondary hover:text-foreground hover:bg-surface'
            }`}
          >
            <ClockIcon className="h-4 w-4" />
            {i18nService.t('scheduledTasks')}
            {unreadScheduledTaskResults > 0 && (
              <span className="ml-auto text-[11px] font-semibold leading-none tabular-nums text-primary/85">
                {unreadScheduledTaskResults > 99 ? '99+' : unreadScheduledTaskResults}
              </span>
            )}
          </button>
          {showWorkboard && (
            <button
              type="button"
              onClick={() => {
                setIsSearchOpen(false);
                onShowWorkboard();
              }}
              className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                activeView === 'workboard'
                  ? 'text-primary hover:bg-surface'
                  : 'text-secondary hover:text-foreground hover:bg-surface'
              }`}
            >
              <Squares2X2Icon className="h-4 w-4" />
              {i18nService.t('workboard')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setIsSearchOpen(false);
              onShowPlugins();
            }}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'plugins'
                ? 'text-primary hover:bg-surface'
                : 'text-secondary hover:text-foreground hover:bg-surface'
            }`}
          >
            <PuzzleIcon className="h-4 w-4" />
            {i18nService.t('plugins')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <CoworkSessionList
          groupRecentSessionsByDate
          sessions={visibleSessions}
          isLoading={false}
          currentSessionId={collaborationAnchors.get(currentSessionId || '') || currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={visibleSelection}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onExportSession={sessionId => void handleSessionListAction(sessionId, 'export')}
          onCopySession={sessionId => void handleSessionListAction(sessionId, 'copy')}
          onCollaborationSession={sessionId =>
            void handleSessionListAction(sessionId, 'collaboration')
          }
          onToggleSelection={handleToggleSelection}
          onEnterBatchMode={handleEnterBatchMode}
        />
      </div>
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={visibleSessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
      />
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
      ) : (
        <div className="mx-3 border-t border-border-subtle pb-3 pt-2 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => onShowSettings()}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-secondary hover:text-foreground hover:bg-surface transition-colors"
            aria-label={i18nService.t('settings')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M14 17H5" />
              <path d="M19 7h-9" />
              <circle cx="17" cy="17" r="3" />
              <circle cx="7" cy="7" r="3" />
            </svg>
            {i18nService.t('settings')}
          </button>
        </div>
      )}
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
  );
};

export default Sidebar;
