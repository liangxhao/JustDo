import {
  ChatBubbleLeftEllipsisIcon,
  CommandLineIcon,
  FolderIcon,
  GlobeAltIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface NewDisplayTabMenuProps {
  browserDisabled?: boolean;
  filesDisabled?: boolean;
  onCreateBrowser: () => void;
  onCreateSideChat?: () => void;
  onCreateTerminal: () => void;
  onOpenFiles?: () => void;
  onOpenReview?: () => void;
  sideChatDisabled?: boolean;
  terminalDisabled?: boolean;
}

const NewDisplayTabMenu = ({
  browserDisabled = false,
  filesDisabled = false,
  onCreateBrowser,
  onCreateSideChat,
  onCreateTerminal,
  onOpenFiles,
  onOpenReview,
  sideChatDisabled = false,
  terminalDisabled = false,
}: NewDisplayTabMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTrigger = useCallback(() => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const closeMenu = useCallback(
    (restoreFocus = false) => {
      setIsOpen(false);
      if (restoreFocus) focusTrigger();
    },
    [focusTrigger],
  );

  useEffect(() => {
    if (!isOpen) return;
    const focusFrame = requestAnimationFrame(() => {
      itemRefs.current.find(item => item && !item.disabled)?.focus();
    });
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, isOpen]);

  const select = (action: () => void, restoreFocus = true) => {
    closeMenu(restoreFocus);
    action();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = itemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    );
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
          isOpen
            ? 'bg-surface-raised text-primary'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground'
        }`}
        onClick={() => setIsOpen(open => !open)}
        aria-label={i18nService.t('coworkNewDisplayTab')}
        title={i18nService.t('coworkNewDisplayTab')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
      {isOpen && (
        <div
          className="absolute right-0 top-full z-[100] mt-1 w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-popover"
          role="menu"
          aria-label={i18nService.t('coworkNewDisplayTab')}
          onKeyDown={handleMenuKeyDown}
        >
          {onCreateSideChat && (
            <button
              ref={element => {
                itemRefs.current[0] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={sideChatDisabled}
              onClick={() => select(onCreateSideChat)}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChatBubbleLeftEllipsisIcon className="h-4 w-4 text-secondary" />
              {i18nService.t('sideChatTitle')}
            </button>
          )}
          {onOpenFiles && (
            <button
              ref={element => {
                itemRefs.current[1] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={filesDisabled}
              onClick={() => select(onOpenFiles, false)}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FolderIcon className="h-4 w-4 text-secondary" />
              {i18nService.t('coworkWorkspaceFiles')}
            </button>
          )}
          <button
            ref={element => {
              itemRefs.current[2] = element;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={browserDisabled}
            onClick={() => select(onCreateBrowser)}
            className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GlobeAltIcon className="h-4 w-4 text-secondary" />
            {i18nService.t('coworkNewBrowserTab')}
          </button>
          <button
            ref={element => {
              itemRefs.current[3] = element;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={terminalDisabled}
            onClick={() => select(onCreateTerminal)}
            className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CommandLineIcon className="h-4 w-4 text-secondary" />
            {i18nService.t('coworkNewTerminalTab')}
          </button>
          {onOpenReview && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              ref={element => {
                itemRefs.current[4] = element;
              }}
              className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground hover:bg-surface-raised"
              onClick={() => select(onOpenReview)}
            >
              <FolderIcon className="h-4 w-4" />
              {i18nService.t('reviewTitle')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default NewDisplayTabMenu;
