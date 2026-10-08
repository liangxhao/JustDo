import { CheckIcon } from '@heroicons/react/24/outline';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { isDomHTMLElement, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

import type { CoworkDisplayTab } from './CoworkDisplayPanel';

interface DisplayTabListMenuProps {
  id: string;
  activeTabId: string;
  anchor: HTMLButtonElement;
  tabs: CoworkDisplayTab[];
  onDismiss: (restoreFocus?: boolean) => void;
  onSelect: (tab: CoworkDisplayTab) => void;
}

export default function DisplayTabListMenu({
  id,
  activeTabId,
  anchor,
  tabs,
  onDismiss,
  onSelect,
}: DisplayTabListMenuProps) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, maxHeight: 360 });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      if (!anchor.isConnected || bounds.width <= 0 || bounds.height <= 0) {
        dismissRef.current(false);
        return;
      }
      const width = Math.max(0, Math.min(320, ownerWindow.innerWidth - 16));
      const maxHeight = Math.max(0, Math.min(360, ownerWindow.innerHeight - 16));
      const height = Math.min(menu?.scrollHeight ?? 0, maxHeight);
      const next = {
        left: Math.max(8, Math.min(bounds.right - width, ownerWindow.innerWidth - width - 8)),
        top: Math.max(8, Math.min(bounds.bottom + 4, ownerWindow.innerHeight - height - 8)),
        width,
        maxHeight,
      };
      setPosition(current =>
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    place();
    const observer = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(place) : null;
    observer?.observe(anchor);
    if (menu) observer?.observe(menu);
    ownerWindow.addEventListener('resize', place);
    ownerWindow.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      ownerWindow.removeEventListener('resize', place);
      ownerWindow.removeEventListener('scroll', place, true);
    };
  }, [anchor, ownerWindow, tabs.length]);

  const revealItem = useCallback((item: HTMLButtonElement | undefined) => {
    const menu = menuRef.current;
    if (!item || !menu) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }, []);

  const focusItem = useCallback(
    (item: HTMLButtonElement | undefined) => {
      item?.focus({ preventScroll: true });
      revealItem(item);
    },
    [revealItem],
  );

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || menu.contains(ownerDocument.activeElement)) return;
    focusItem(
      menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
        menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]') ??
        undefined,
    );
  }, [activeTabId, focusItem, ownerDocument, tabs]);

  useLayoutEffect(() => {
    const activeElement = ownerDocument.activeElement;
    if (
      isDomHTMLElement(activeElement) &&
      activeElement.tagName === 'BUTTON' &&
      menuRef.current?.contains(activeElement)
    ) {
      revealItem(activeElement as HTMLButtonElement);
    }
  }, [ownerDocument, position.maxHeight, revealItem]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (!items.length) return;
    const current = items.indexOf(ownerDocument.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    focusItem(items[next]);
  };

  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="fixed inset-0 z-[109] cursor-default"
        aria-label={i18nService.t('coworkDisplayTabListDismiss')}
        onClick={() => onDismiss()}
        onContextMenu={event => {
          event.preventDefault();
          onDismiss();
        }}
      />
      <div
        id={id}
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('coworkDisplayTabList')}
        className="fixed z-[110] overflow-y-auto rounded-lg border border-border bg-background p-1.5 text-foreground shadow-2xl"
        style={position}
        onKeyDown={handleKeyDown}
        onContextMenu={event => event.preventDefault()}
      >
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="menuitemradio"
            aria-checked={tab.id === activeTabId}
            tabIndex={-1}
            title={tab.label}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            onClick={() => onSelect(tab)}
          >
            <span className="h-4 w-4 shrink-0" aria-hidden="true">
              {tab.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{tab.label}</span>
            <span className="h-4 w-4 shrink-0" aria-hidden="true">
              {tab.id === activeTabId && <CheckIcon className="h-4 w-4" />}
            </span>
          </button>
        ))}
      </div>
    </>,
    ownerDocument.body,
  );
}
