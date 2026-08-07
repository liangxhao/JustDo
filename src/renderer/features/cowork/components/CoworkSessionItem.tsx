import { useDraggable } from '@dnd-kit/core';
import {
  BookmarkIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import CoworkSessionDetailsModal from '@/features/cowork/components/CoworkSessionDetailsModal';
import type {
  CoworkSessionStatus,
  CoworkSessionSummary,
  SessionGroup,
} from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ListChecksIcon from '@/shared/components/icons/ListChecksIcon';
import PencilSquareIcon from '@/shared/components/icons/PencilSquareIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

interface CoworkSessionItemProps {
  session: CoworkSessionSummary;
  hasUnread: boolean;
  isActive: boolean;
  isRuntimeRunning?: boolean;
  isBatchMode: boolean;
  isSelected: boolean;
  showBatchOption?: boolean;
  groups?: SessionGroup[];
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onTogglePinned: () => void;
  onToggleSelection: () => void;
  onEnterBatchMode: () => void;
  onMoveToGroup?: (groupId: string | null) => void;
}

const statusLabels: Record<CoworkSessionStatus, string> = {
  idle: 'coworkStatusIdle',
  running: 'coworkStatusRunning',
  completed: 'coworkStatusCompleted',
  error: 'coworkStatusError',
};

const CoworkSessionItem: React.FC<CoworkSessionItemProps> = ({
  session,
  hasUnread,
  isActive,
  isRuntimeRunning = false,
  isBatchMode,
  isSelected,
  showBatchOption = true,
  groups = [],
  onSelect,
  onDelete,
  onRename,
  onTogglePinned,
  onToggleSelection,
  onEnterBatchMode,
  onMoveToGroup,
}) => {
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [showGroupSubMenu, setShowGroupSubMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionItemRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);
  const closeSubMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openSubMenu = () => {
    if (closeSubMenuTimerRef.current) {
      clearTimeout(closeSubMenuTimerRef.current);
      closeSubMenuTimerRef.current = null;
    }
    setShowGroupSubMenu(true);
  };

  const closeSubMenu = () => {
    closeSubMenuTimerRef.current = setTimeout(() => {
      setShowGroupSubMenu(false);
    }, 100);
  };

  // Draggable setup
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: session.id,
    data: { session },
  });

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(session.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, session.title]);

  const calculateMenuPosition = (clickX: number, clickY: number) => {
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, clickX),
      Math.max(padding, window.innerWidth - menuWidth - padding),
    );
    const y = Math.max(padding, clickY + 4);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    setMenuPosition(calculateMenuPosition(e.clientX, e.clientY));
    setShowConfirmDelete(false);
  };

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
    setShowGroupSubMenu(false);
    if (closeSubMenuTimerRef.current) {
      clearTimeout(closeSubMenuTimerRef.current);
      closeSubMenuTimerRef.current = null;
    }
  }, []);

  const handleRenameClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      ignoreNextBlurRef.current = false;
      setIsRenaming(true);
      setShowConfirmDelete(false);
      setRenameValue(session.title);
      setMenuPosition(null);
    },
    [session.title],
  );

  const handleRenameSave = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== session.title) {
      onRename(nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(session.title);
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  }, []);

  const handleConfirmDelete = () => {
    onDelete();
    setShowConfirmDelete(false);
  };

  const handleCancelDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmDelete(false);
  };

  const handleBatchClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeMenu();
      onEnterBatchMode();
    },
    [closeMenu, onEnterBatchMode],
  );

  const handleCopySessionId = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      closeMenu();
      try {
        const result = await window.electron.cowork.getGatewaySessionId(session.id);
        if (!result.success || !result.sessionId) {
          throw new Error(result.error || 'Gateway session ID is unavailable');
        }
        await navigator.clipboard.writeText(result.sessionId);
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('copySessionIdSuccess'),
          }),
        );
      } catch {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('copySessionIdFailed'),
          }),
        );
      }
    },
    [closeMenu, session.id],
  );

  const handleShowDetails = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeMenu();
      setShowDetails(true);
    },
    [closeMenu],
  );

  const handleTogglePinned = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeMenu();
      onTogglePinned();
    },
    [closeMenu, onTogglePinned],
  );

  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [closeMenu, menuPosition]);

  useLayoutEffect(() => {
    if (!menuPosition || !menuRef.current) return;
    const padding = 8;
    const rect = menuRef.current.getBoundingClientRect();
    const nextX = Math.min(
      Math.max(padding, menuPosition.x),
      Math.max(padding, window.innerWidth - rect.width - padding),
    );
    const nextY = Math.min(
      Math.max(padding, menuPosition.y),
      Math.max(padding, window.innerHeight - rect.height - padding),
    );
    if (nextX !== menuPosition.x || nextY !== menuPosition.y) {
      setMenuPosition({ x: nextX, y: nextY });
    }
  }, [groups.length, menuPosition, showGroupSubMenu]);

  const setSessionNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      sessionItemRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  const renameLabel = i18nService.t('renameConversation');
  const deleteLabel = i18nService.t('deleteSession');
  const showRunningIndicator = isRuntimeRunning;
  const showUnreadIndicator = !showRunningIndicator && hasUnread;
  const showStatusIndicator = showRunningIndicator || showUnreadIndicator;
  const batchLabel = i18nService.t('batchOperations');
  const moveToGroupLabel = i18nService.t('moveToGroup');
  const copySessionIdLabel = i18nService.t('copySessionId');
  const sessionDetailsLabel = i18nService.t('sessionDetailsMenu');
  const togglePinnedLabel = i18nService.t(session.pinned ? 'unpinConversation' : 'pinConversation');

  interface MenuItem {
    key: string;
    label: string;
    onClick: (e: React.MouseEvent) => void;
    onMouseEnter?: () => void;
    tone: 'neutral' | 'danger';
    isCheckbox?: boolean;
    checked?: boolean;
  }

  const menuItems = useMemo(() => {
    const items: MenuItem[] = [
      {
        key: 'details',
        label: sessionDetailsLabel,
        onClick: handleShowDetails,
        tone: 'neutral' as const,
      },
      {
        key: 'pin',
        label: togglePinnedLabel,
        onClick: handleTogglePinned,
        tone: 'neutral' as const,
      },
      { key: 'rename', label: renameLabel, onClick: handleRenameClick, tone: 'neutral' as const },
      {
        key: 'copySessionId',
        label: copySessionIdLabel,
        onClick: handleCopySessionId,
        tone: 'neutral' as const,
      },
    ];
    if (showBatchOption) {
      items.unshift({
        key: 'batch',
        label: batchLabel,
        onClick: handleBatchClick,
        tone: 'neutral' as const,
      });
    }
    if (onMoveToGroup && groups.length > 0) {
      items.push({
        key: 'moveToGroup',
        label: moveToGroupLabel,
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
        },
        onMouseEnter: openSubMenu,
        tone: 'neutral' as const,
      });
    }
    items.push({
      key: 'delete',
      label: deleteLabel,
      onClick: handleDeleteClick,
      tone: 'danger' as const,
    });
    return items;
  }, [
    batchLabel,
    copySessionIdLabel,
    deleteLabel,
    handleBatchClick,
    handleCopySessionId,
    handleDeleteClick,
    handleShowDetails,
    handleTogglePinned,
    handleRenameClick,
    renameLabel,
    showBatchOption,
    onMoveToGroup,
    groups.length,
    moveToGroupLabel,
    sessionDetailsLabel,
    togglePinnedLabel,
  ]);

  const handleMoveToGroup = (groupId: string | null) => {
    if (onMoveToGroup) {
      onMoveToGroup(groupId);
    }
    closeMenu();
  };

  return (
    <>
      <div
        ref={setSessionNodeRef}
        {...attributes}
        {...listeners}
        style={{ opacity: isDragging ? 0.5 : 1 }}
        onContextMenu={!isBatchMode && !isRenaming ? openMenu : undefined}
        onClick={() => {
          if (isRenaming) return;
          closeMenu();
          if (isBatchMode) {
            onToggleSelection();
            return;
          }
          onSelect();
        }}
        aria-current={isActive ? 'page' : undefined}
        className={`group relative min-h-8 rounded-lg pl-7 pr-2 py-1.5 cursor-pointer transition-all duration-150 ${
          isActive
            ? 'bg-primary/[0.12] text-primary shadow-sm ring-1 ring-inset ring-primary/25 hover:bg-primary/[0.16]'
            : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
        }`}
      >
        {isActive && (
          <span
            aria-hidden="true"
            className="absolute inset-y-2 left-1.5 w-1 rounded-full bg-primary shadow-[0_0_6px_var(--justdo-primary-muted)]"
          />
        )}

        {/* Content area */}
        <div className="flex items-center">
          {isBatchMode && (
            <div className="mr-2 flex flex-shrink-0 items-center">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={e => {
                  e.stopPropagation();
                  onToggleSelection();
                }}
                onClick={e => e.stopPropagation()}
                className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-primary cursor-pointer"
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className={`flex items-center ${showStatusIndicator ? 'gap-2' : 'gap-0'}`}>
              {/* Status indicator */}
              {showStatusIndicator && (
                <span
                  className={`block w-2 h-2 rounded-full flex-shrink-0 ${
                    showRunningIndicator
                      ? 'bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.5)] animate-pulse'
                      : 'bg-primary'
                  }`}
                  title={showRunningIndicator ? i18nService.t(statusLabels.running) : undefined}
                />
              )}
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={event => setRenameValue(event.target.value)}
                  onClick={event => event.stopPropagation()}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      handleRenameSave(event);
                    }
                    if (event.key === 'Escape') {
                      handleRenameCancel(event);
                    }
                  }}
                  onBlur={handleRenameBlur}
                  className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2 py-1 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
              ) : (
                <div className="flex-1 min-w-0 flex items-center gap-1">
                  <Tooltip
                    content={session.title}
                    position="top"
                    delay={500}
                    className="flex-1 min-w-0"
                  >
                    <h3
                      className={`cowork-session-title truncate text-xs leading-5 ${
                        isActive ? 'font-semibold text-primary' : 'font-normal text-foreground'
                      }`}
                    >
                      {session.title}
                    </h3>
                  </Tooltip>
                </div>
              )}
            </div>
          </div>
        </div>

        {menuPosition && (
          <div
            ref={menuRef}
            className="fixed z-50 min-w-[160px] overflow-y-auto rounded-xl border border-border bg-surface shadow-lg"
            style={{
              top: menuPosition.y,
              left: menuPosition.x,
              maxHeight: 'calc(100vh - 16px)',
            }}
            role="menu"
          >
            {menuItems.map(item => (
              <button
                key={item.key}
                type="button"
                onClick={item.onClick}
                onMouseEnter={item.onMouseEnter}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  item.tone === 'danger'
                    ? 'text-red-500 hover:bg-red-500/10'
                    : 'text-foreground hover:bg-surface-raised'
                }`}
              >
                {item.key === 'batch' && <ListChecksIcon className="h-4 w-4" />}
                {item.key === 'details' && <InformationCircleIcon className="h-4 w-4" />}
                {item.key === 'pin' && (
                  <BookmarkIcon className={`h-4 w-4 ${session.pinned ? 'fill-current' : ''}`} />
                )}
                {item.key === 'rename' && <PencilSquareIcon className="h-4 w-4" />}
                {item.key === 'copySessionId' && <DocumentDuplicateIcon className="h-4 w-4" />}
                {item.key === 'delete' && <TrashIcon className="h-4 w-4" />}
                {item.key === 'moveToGroup' && (
                  <span className="h-4 w-4 flex items-center justify-center">→</span>
                )}
                {item.isCheckbox && (
                  <span className="h-4 w-4 flex items-center justify-center">
                    {item.checked ? (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        className="h-4 w-4"
                      >
                        <rect
                          x="3"
                          y="3"
                          width="18"
                          height="18"
                          rx="2"
                          className="fill-primary stroke-primary"
                        />
                        <path
                          d="M9 12l2 2 4-4"
                          stroke="white"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        className="h-4 w-4"
                      >
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      </svg>
                    )}
                  </span>
                )}
                {item.label}
                {item.key === 'moveToGroup' && (
                  <span className="ml-auto">{showGroupSubMenu ? '▼' : '▶'}</span>
                )}
              </button>
            ))}
            {/* Group submenu */}
            {showGroupSubMenu && onMoveToGroup && (
              <div
                className="border-t border-border pl-5"
                onMouseEnter={openSubMenu}
                onMouseLeave={closeSubMenu}
              >
                {/* Ungrouped option */}
                {session.groupId && (
                  <button
                    type="button"
                    onClick={() => handleMoveToGroup(null)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-surface-raised"
                  >
                    {i18nService.t('ungrouped')}
                  </button>
                )}
                {groups.map(group => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => handleMoveToGroup(group.id)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs ${
                      session.groupId === group.id
                        ? 'bg-surface-raised text-secondary'
                        : 'text-foreground hover:bg-surface-raised'
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: group.color }}
                    />
                    {group.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {showConfirmDelete && (
          <Modal
            onClose={handleCancelDelete}
            className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                {i18nService.t('deleteTaskConfirmTitle')}
              </h2>
            </div>

            {/* Content */}
            <div className="px-5 pb-4">
              <p className="text-sm text-secondary">{i18nService.t('deleteTaskConfirmMessage')}</p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('deleteSession')}
              </button>
            </div>
          </Modal>
        )}
      </div>
      {showDetails && (
        <CoworkSessionDetailsModal
          sessionSummary={session}
          groups={groups}
          isRuntimeRunning={isRuntimeRunning}
          returnFocusRef={sessionItemRef}
          onClose={handleCloseDetails}
        />
      )}
    </>
  );
};

export default CoworkSessionItem;
