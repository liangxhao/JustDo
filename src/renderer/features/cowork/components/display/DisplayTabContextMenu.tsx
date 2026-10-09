import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

export interface DisplayTabContextMenuItem {
  id: string;
  icon?: React.ReactNode;
  label: string;
  onSelect: () => void | Promise<void>;
}

interface DisplayTabContextMenuProps {
  canClose: boolean;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  items?: DisplayTabContextMenuItem[];
  onClose: () => void | Promise<void>;
  onCloseOthers: () => void | Promise<void>;
  onCloseRight: () => void | Promise<void>;
  onActionComplete: () => void;
  onDismiss: (restoreFocus?: boolean) => void;
  x: number;
  y: number;
}

const DisplayTabContextMenu = ({
  canClose,
  canCloseOthers,
  canCloseRight,
  items = [],
  onClose,
  onCloseOthers,
  onCloseRight,
  onActionComplete,
  onDismiss,
  x,
  y,
}: DisplayTabContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(8, Math.min(x, window.innerWidth - 296));
  const estimatedHeight = 16 + (items.length + 3) * 36 + (items.length ? 5 : 0);
  const top = Math.max(8, Math.min(y, window.innerHeight - estimatedHeight));

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  const runAction = (action: () => void | Promise<void>) => {
    onDismiss(false);
    void Promise.resolve(action()).then(onActionComplete, onActionComplete);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const menuItems = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    if (!menuItems.length) return;
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? menuItems.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + menuItems.length) %
            menuItems.length;
    menuItems[nextIndex]?.focus();
  };

  const closeItems = [
    {
      id: 'close',
      label: i18nService.t('close'),
      disabled: !canClose,
      onSelect: onClose,
    },
    {
      id: 'close-others',
      label: i18nService.t('browserTabMenuCloseOthers'),
      disabled: !canCloseOthers,
      onSelect: onCloseOthers,
    },
    {
      id: 'close-right',
      label: i18nService.t('browserTabMenuCloseRight'),
      disabled: !canCloseRight,
      onSelect: onCloseRight,
    },
  ];

  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="fixed inset-0 z-[109] cursor-default"
        aria-label={i18nService.t('coworkDisplayTabMenuDismiss')}
        onClick={() => onDismiss()}
        onContextMenu={event => {
          event.preventDefault();
          onDismiss();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('coworkDisplayTabMenu')}
        className="fixed z-[110] w-72 overflow-y-auto rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-2xl"
        style={{ left, top, maxHeight: 'calc(100vh - 16px)' }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={handleKeyDown}
      >
        {items.length > 0 && (
          <div className="mb-1 border-b border-border pb-1">
            {items.map(item => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised"
                onClick={() => runAction(item.onSelect)}
              >
                {item.icon}
                <span className="whitespace-nowrap">{item.label}</span>
              </button>
            ))}
          </div>
        )}
        {closeItems.map(item => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised disabled:opacity-40"
            onClick={() => runAction(item.onSelect)}
          >
            <XMarkIcon className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">{item.label}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
};

export default DisplayTabContextMenu;
