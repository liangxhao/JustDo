import React, { useEffect, useState, useCallback } from 'react';
import Modal from './common/Modal';
import { useSelector } from 'react-redux';
import {
  selectCoworkSessions,
  selectCurrentSessionId,
  selectIsOpenClawEngine,
} from '../store/selectors/coworkSelectors';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import ComposeIcon from './icons/ComposeIcon';
import SearchIcon from './icons/SearchIcon';
import ClockIcon from './icons/ClockIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import TrashIcon from './icons/TrashIcon';
import ArrowUpRightIcon from './icons/ArrowUpRightIcon';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface SidebarProps {
  onShowSettings: () => void;
  activeView: 'cowork' | 'scheduledTasks';
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowCowork,
  onShowScheduledTasks,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
}) => {
  const sessions = useSelector(selectCoworkSessions);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
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

  const handleSelectSession = async (sessionId: string) => {
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.deleteSession(sessionId);
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
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

  const handleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === sessions.length) {
        return new Set();
      }
      return new Set(sessions.map(s => s.id));
    });
  }, [sessions]);

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowBatchDeleteConfirm(true);
  }, [selectedIds.size]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    await coworkService.deleteSessions(ids);
    handleExitBatchMode();
  }, [selectedIds, handleExitBatchMode]);

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
          </div>
          <div className="flex items-center gap-1">
            {isOpenClawEngine && (
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
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'cowork'
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'text-secondary hover:text-foreground hover:bg-surface-raised'
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
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scheduledTasks'
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'text-secondary hover:text-foreground hover:bg-surface-raised'
            }`}
          >
            <ClockIcon className="h-4 w-4" />
            {i18nService.t('scheduledTasks')}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <CoworkSessionList
          sessions={sessions}
          isLoading={false}
          currentSessionId={currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={selectedIds}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onToggleSelection={handleToggleSelection}
          onEnterBatchMode={handleEnterBatchMode}
        />
      </div>
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
      />
      {isBatchMode ? (
        <div className="px-3 pb-3 pt-1 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer text-sm text-secondary">
            <input
              type="checkbox"
              checked={selectedIds.size === sessions.length && sessions.length > 0}
              onChange={handleSelectAll}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-primary cursor-pointer"
            />
            {i18nService.t('batchSelectAll')}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBatchDeleteClick}
              disabled={selectedIds.size === 0}
              className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                selectedIds.size > 0
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
              }`}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {selectedIds.size > 0 ? `${selectedIds.size}` : ''}
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
        <div className="px-3 pb-3 pt-1 flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => onShowSettings()}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
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
                .replace('{count}', String(selectedIds.size))}
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
              {i18nService.t('batchDelete')} ({selectedIds.size})
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
};

export default Sidebar;
