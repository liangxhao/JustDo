import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

export interface WorkspaceFilesMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  separated?: boolean;
  onSelect: () => void;
}

interface WorkspaceFilesContextMenuProps {
  items: WorkspaceFilesMenuItem[];
  onDismiss: () => void;
  x: number;
  y: number;
}

export default function WorkspaceFilesContextMenu({
  items,
  onDismiss,
  x,
  y,
}: WorkspaceFilesContextMenuProps) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, ownerWindow.innerWidth - (rect?.width || 240) - 8)),
      top: Math.max(8, Math.min(y, ownerWindow.innerHeight - (rect?.height || 300) - 8)),
    });
  }, [x, y, ownerWindow]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={i18nService.t('coworkWorkspaceFilesMenuDismiss')}
        className="fixed inset-0 z-[109] cursor-default"
        onClick={onDismiss}
        onContextMenu={event => {
          event.preventDefault();
          onDismiss();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('coworkWorkspaceFilesMenu')}
        className="fixed z-[110] w-60 overflow-y-auto rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-2xl"
        style={{ ...position, maxHeight: 'calc(100vh - 16px)' }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={event => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ) ?? [],
          );
          const index = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
          const nextIndex =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[nextIndex]?.focus();
        }}
      >
        {items.map(item => (
          <div key={item.id} className={item.separated ? 'mt-1 border-t border-border pt-1' : ''}>
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => {
                onDismiss();
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          </div>
        ))}
      </div>
    </>,
    ownerDocument.body,
  );
}
