import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

interface TerminalContextMenuProps {
  canCopy: boolean;
  onClear: () => void;
  onCopy: () => void;
  onDismiss: () => void;
  onFind: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  x: number;
  y: number;
}

const TerminalContextMenu = ({
  canCopy,
  onClear,
  onCopy,
  onDismiss,
  onFind,
  onPaste,
  onSelectAll,
  x,
  y,
}: TerminalContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(8, Math.min(x, window.innerWidth - 224));
  const top = Math.max(8, Math.min(y, window.innerHeight - 260));

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  const run = (action: () => void) => {
    onDismiss();
    action();
  };

  const items = [
    { label: i18nService.t('coworkTerminalCopy'), action: onCopy, disabled: !canCopy },
    { label: i18nService.t('coworkTerminalPaste'), action: onPaste },
    { label: i18nService.t('coworkTerminalSelectAll'), action: onSelectAll },
    { label: i18nService.t('coworkTerminalFind'), action: onFind, separated: true },
    { label: i18nService.t('coworkTerminalClear'), action: onClear },
  ];

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[109] cursor-default"
        aria-label={i18nService.t('coworkTerminalMenuDismiss')}
        onClick={onDismiss}
        onContextMenu={event => {
          event.preventDefault();
          onDismiss();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('coworkTerminalMenu')}
        className="fixed z-[110] w-52 rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-2xl"
        style={{ left, top }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onDismiss();
        }}
      >
        {items.map(item => (
          <div
            key={item.label}
            className={item.separated ? 'mt-1 border-t border-border pt-1' : ''}
          >
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="flex w-full items-center rounded-md px-2.5 py-2 text-left hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => run(item.action)}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
};

export default TerminalContextMenu;
