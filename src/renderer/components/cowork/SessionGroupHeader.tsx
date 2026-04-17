import React, { useState, useRef, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { SessionGroup } from '../../types/cowork';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface SessionGroupHeaderProps {
  group: SessionGroup;
  sessionCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRename: (name: string) => void;
  onUpdateColor: (color: string) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

const GROUP_COLORS = ['#ef4444', '#f97316', '#22c55e', '#3b82f6', '#8b5cf6', '#6366f1'];

const ChevronIcon: React.FC<React.SVGProps<SVGSVGElement> & { direction: 'up' | 'down' }> = ({
  direction,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d={direction === 'down' ? 'M6 9l6 6 6-6' : 'M18 15l-6-6-6 6'} />
  </svg>
);

const SessionGroupHeader: React.FC<SessionGroupHeaderProps> = ({
  group,
  sessionCount,
  isExpanded,
  onToggleExpand,
  onRename,
  onUpdateColor,
  onDelete,
  onMoveUp,
  onMoveDown,
}) => {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Droppable setup - allows dropping sessions onto this group header
  const { setNodeRef, isOver } = useDroppable({
    id: `group-${group.id}`,
    data: { group },
  });

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (!menuPosition) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPosition(null);
        setShowColorPicker(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuPosition(null);
        setShowColorPicker(false);
      }
    };

    const handleScroll = () => {
      setMenuPosition(null);
      setShowColorPicker(false);
    };

    const handleResize = () => {
      setMenuPosition(null);
      setShowColorPicker(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [menuPosition]);

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 160);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    setMenuPosition({ x, y });
  };

  const handleRenameSubmit = () => {
    if (renameValue.trim() && renameValue.trim() !== group.name) {
      onRename(renameValue.trim());
    }
    setIsRenaming(false);
    setMenuPosition(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenameValue(group.name);
      setIsRenaming(false);
    }
  };

  const handleDeleteConfirm = () => {
    onDelete();
    setShowDeleteModal(false);
    setMenuPosition(null);
  };

  const handleColorSelect = (color: string) => {
    onUpdateColor(color);
    setShowColorPicker(false);
    setMenuPosition(null);
  };

  return (
    <>
      <div
        ref={setNodeRef}
        className={`session-group-header ${menuPosition ? 'has-menu' : ''} ${isOver ? 'drop-target' : ''}`}
        onClick={onToggleExpand}
        onContextMenu={openMenu}
        style={{ cursor: 'pointer' }}
      >
        <div className="group-indicator" style={{ backgroundColor: group.color }} />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            className="rename-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="group-name">{group.name}</span>
        )}
        <span className="group-count">({sessionCount})</span>
        <ChevronIcon
          direction={isExpanded ? 'up' : 'down'}
          className="chevron-icon"
          width={14}
          height={14}
        />
      </div>

      {menuPosition && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{
            position: 'fixed',
            left: menuPosition.x,
            top: menuPosition.y,
            zIndex: 1000,
          }}
        >
          <div className="menu-item" onClick={() => setIsRenaming(true)}>
            {i18nService.t('rename')}
          </div>
          <div className="menu-item" onClick={() => setShowColorPicker(true)}>
            {i18nService.t('changeColor')}
          </div>
          {showColorPicker && (
            <div className="color-picker">
              {GROUP_COLORS.map(color => (
                <div
                  key={color}
                  className="color-option"
                  style={{ backgroundColor: color }}
                  onClick={() => handleColorSelect(color)}
                />
              ))}
            </div>
          )}
          {onMoveUp && (
            <div
              className="menu-item"
              onClick={() => {
                onMoveUp();
                setMenuPosition(null);
              }}
            >
              {i18nService.t('moveUp')}
            </div>
          )}
          {onMoveDown && (
            <div
              className="menu-item"
              onClick={() => {
                onMoveDown();
                setMenuPosition(null);
              }}
            >
              {i18nService.t('moveDown')}
            </div>
          )}
          <div className="menu-item danger" onClick={() => setShowDeleteModal(true)}>
            {i18nService.t('delete')}
          </div>
        </div>
      )}

      {showDeleteModal && (
        <Modal
          onClose={() => setShowDeleteModal(false)}
          className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
              <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('deleteGroup')}
            </h2>
          </div>
          <div className="px-5 pb-4">
            <p>{i18nService.t('deleteGroupConfirm')}</p>
            <p className="text-secondary font-medium mb-2">"{group.name}"</p>
            <p className="text-secondary text-sm">{i18nService.t('deleteGroupNote')}</p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
            <button
              onClick={() => setShowDeleteModal(false)}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              onClick={handleDeleteConfirm}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
            >
              {i18nService.t('delete')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
};

export default SessionGroupHeader;
