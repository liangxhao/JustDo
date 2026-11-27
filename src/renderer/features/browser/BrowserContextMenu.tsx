import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { isDomHTMLElement, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

export type BrowserContextMenuItem<Action extends string> = {
  action: Action;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
};

export default function BrowserContextMenu<Action extends string>({
  x,
  y,
  label,
  dismissLabel,
  groups,
  height,
  restoreTriggerFocus = true,
  onAction,
  onDismiss,
}: {
  x: number;
  y: number;
  label: string;
  dismissLabel?: string;
  groups: BrowserContextMenuItem<Action>[][];
  height: number;
  restoreTriggerFocus?: boolean;
  onAction: (action: Action) => void;
  onDismiss: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(8, Math.min(x, ownerWindow.innerWidth - 232));
  const top = Math.max(8, Math.min(y, ownerWindow.innerHeight - height));

  useEffect(() => {
    const trigger = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      if (restoreTriggerFocus) trigger?.focus();
    };
  }, [ownerDocument, restoreTriggerFocus]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    if (!items.length) return;
    const currentIndex = items.indexOf(ownerDocument.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        aria-label={dismissLabel}
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
        aria-label={label}
        className="fixed z-[110] w-56 overflow-y-auto rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-2xl"
        style={{ left, top, maxHeight: 'calc(100vh - 16px)' }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={handleKeyDown}
      >
        {groups.map((items, groupIndex) => (
          <div
            key={items[0]!.action}
            className={groupIndex ? 'mt-1 border-t border-border pt-1' : ''}
          >
            {items.map(item => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised focus-visible:bg-surface-raised disabled:opacity-40"
                onClick={() => onAction(item.action)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>,
    ownerDocument.body,
  );
}
