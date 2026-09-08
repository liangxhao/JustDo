import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';
import ClockIcon from '@/shared/components/icons/ClockIcon';
import FolderIcon from '@/shared/components/icons/FolderIcon';
import FolderPlusIcon from '@/shared/components/icons/FolderPlusIcon';
import { getCompactFolderName } from '@/utils/path';

const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;
const POPOVER_MAX_WIDTH = 360;

interface PopoverPosition {
  left: number;
  top: number;
  width: number;
}

export const calculatePopoverPosition = (
  anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top'>,
  popoverHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): PopoverPosition => {
  const width = Math.max(0, Math.min(POPOVER_MAX_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2));
  const spaceAbove = anchorRect.top - VIEWPORT_MARGIN;
  const spaceBelow = viewportHeight - anchorRect.bottom - VIEWPORT_MARGIN;
  const openAbove = spaceAbove >= popoverHeight + POPOVER_GAP || spaceAbove >= spaceBelow;
  const preferredTop = openAbove
    ? anchorRect.top - popoverHeight - POPOVER_GAP
    : anchorRect.bottom + POPOVER_GAP;

  return {
    left: Math.min(
      Math.max(anchorRect.left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    ),
    top: Math.min(
      Math.max(preferredTop, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportHeight - popoverHeight - VIEWPORT_MARGIN),
    ),
    width,
  };
};

interface FolderSelectorPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFolder: (path: string) => void;
  anchorRef: React.RefObject<HTMLElement>;
  currentFolder?: string;
}

export const areFolderPathsEqual = (
  firstPath: string,
  secondPath: string,
  platform: string,
): boolean => {
  const normalize = (path: string) => path.trim().replace(/[\\/]+$/, '');
  const first = normalize(firstPath);
  const second = normalize(secondPath);
  return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
};

const FolderSelectorPopover: React.FC<FolderSelectorPopoverProps> = ({
  isOpen,
  onClose,
  onSelectFolder,
  anchorRef,
  currentFolder = '',
}) => {
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const chooseFolderButtonRef = useRef<HTMLButtonElement>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const popoverHeight = popoverRef.current?.offsetHeight ?? 360;
    setPosition(
      calculatePopoverPosition(anchorRect, popoverHeight, window.innerWidth, window.innerHeight),
    );
  }, [anchorRef]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setIsLoading(true);
    setPosition(null);
    void coworkService
      .getRecentCwds(8)
      .then(folders => {
        if (!cancelled) {
          setRecentFolders(Array.from(new Set(folders.filter(Boolean))));
        }
      })
      .catch(error => {
        console.error('Failed to load recent folders:', error);
        if (!cancelled) setRecentFolders([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (popoverRef.current) observer.observe(popoverRef.current);

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, isLoading, recentFolders.length, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const anchor = anchorRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      chooseFolderButtonRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      anchor?.focus();
    };
  }, [anchorRef, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, isOpen, onClose]);

  const isWindowsDriveRoot = (dirPath: string): boolean => {
    if (window.electron.platform !== 'win32') return false;
    return /^[a-zA-Z]:[/\\]?$/.test(dirPath.trim());
  };

  const handleChooseFolder = async () => {
    onClose();
    try {
      const result = await window.electron.dialog.selectDirectory();
      if (result.success && result.path) {
        if (isWindowsDriveRoot(result.path)) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('folderDriveRootNotAllowed'),
            }),
          );
          return;
        }
        onSelectFolder(result.path);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleSelectRecentFolder = (path: string) => {
    if (isWindowsDriveRoot(path)) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('folderDriveRootNotAllowed'),
        }),
      );
      return;
    }
    onSelectFolder(path);
    onClose();
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={i18nService.t('workspacePickerTitle')}
      className="fixed z-[70] flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-popover"
      style={{
        left: position?.left ?? VIEWPORT_MARGIN,
        top: position?.top ?? VIEWPORT_MARGIN,
        width: position?.width ?? POPOVER_MAX_WIDTH,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="shrink-0 border-b border-border px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold text-foreground">
          {i18nService.t('workspacePickerTitle')}
        </h2>
        <p className="mt-1 text-xs leading-5 text-secondary">
          {i18nService.t('workspacePickerDescription')}
        </p>
      </div>

      <div className="shrink-0 p-2">
        <button
          ref={chooseFolderButtonRef}
          type="button"
          onClick={() => void handleChooseFolder()}
          className="group flex w-full items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <FolderPlusIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {i18nService.t('addFolder')}
            </span>
            <span className="mt-0.5 block text-xs text-secondary">
              {i18nService.t('workspacePickerBrowseHint')}
            </span>
          </span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <div className="flex items-center gap-2 px-2 pb-2 pt-1 text-xs font-medium text-secondary">
          <ClockIcon className="h-3.5 w-3.5" />
          <span>{i18nService.t('recentFolders')}</span>
          {!isLoading && recentFolders.length > 0 && (
            <span className="ml-auto tabular-nums text-[11px] text-secondary/70">
              {recentFolders.length}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {isLoading ? (
            <div className="space-y-1 px-1 py-1" aria-label={i18nService.t('loading')}>
              {[0, 1, 2].map(item => (
                <div
                  key={item}
                  className="flex animate-pulse items-center gap-3 rounded-xl px-2 py-2"
                >
                  <span className="h-8 w-8 shrink-0 rounded-lg bg-surface-raised" />
                  <span className="h-3 w-2/3 rounded bg-surface-raised" />
                </div>
              ))}
            </div>
          ) : recentFolders.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-6 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-secondary">
                <FolderIcon className="h-5 w-5" />
              </span>
              <span className="mt-2 text-sm font-medium text-foreground">
                {i18nService.t('noRecentFolders')}
              </span>
              <span className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('workspacePickerEmptyHint')}
              </span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {recentFolders.map(folder => {
                const isCurrent =
                  Boolean(currentFolder) &&
                  areFolderPathsEqual(folder, currentFolder, window.electron.platform);
                return (
                  <button
                    key={folder}
                    type="button"
                    onClick={() => handleSelectRecentFolder(folder)}
                    title={folder}
                    aria-current={isCurrent ? 'true' : undefined}
                    className={`group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      isCurrent ? 'bg-primary/10' : 'hover:bg-surface-raised'
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        isCurrent
                          ? 'bg-primary/15 text-primary'
                          : 'bg-surface-raised text-secondary group-hover:text-foreground'
                      }`}
                    >
                      <FolderIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {getCompactFolderName(folder) || i18nService.t('noFolderSelected')}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-secondary">
                        {folder}
                      </span>
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        {i18nService.t('workspacePickerCurrent')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default FolderSelectorPopover;
