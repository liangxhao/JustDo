import {
  ChatBubbleOvalLeftIcon,
  CheckIcon,
  PencilIcon,
  RectangleGroupIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { isDomHTMLElement, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

export type BrowserAnnotationTool = 'inspect' | 'pen' | 'rectangle';

export default function BrowserAnnotationToolMenu({
  anchor,
  selected,
  onSelect,
  onDismiss,
}: {
  anchor: { left: number; right: number; top: number; bottom: number };
  selected: BrowserAnnotationTool;
  onSelect: (tool: BrowserAnnotationTool) => void;
  onDismiss: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    const selectedItem = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (
      selectedItem ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
    )?.focus();
    return () => trigger?.focus();
  }, [ownerDocument]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []),
    ];
    const current = items.indexOf(ownerDocument.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  const menuWidth = 176;
  const menuHeight = 128;
  const left = Math.max(8, Math.min(anchor.left, ownerWindow.innerWidth - menuWidth - 8));
  const top =
    anchor.bottom + menuHeight + 8 <= ownerWindow.innerHeight
      ? anchor.bottom + 6
      : Math.max(8, anchor.top - menuHeight - 6);
  const items: Array<{
    tool: BrowserAnnotationTool;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      tool: 'inspect',
      label: i18nService.t('browserPanelInspect'),
      icon: <ChatBubbleOvalLeftIcon className="h-4 w-4" />,
    },
    {
      tool: 'pen',
      label: i18nService.t('browserPanelPen'),
      icon: <PencilIcon className="h-4 w-4" />,
    },
    {
      tool: 'rectangle',
      label: i18nService.t('browserPanelRectangle'),
      icon: <RectangleGroupIcon className="h-4 w-4" />,
    },
  ];

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[109] cursor-default"
        aria-label={i18nService.t('browserAnnotationToolMenuDismiss')}
        onClick={onDismiss}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('browserAnnotationToolMenu')}
        className="fixed z-[110] w-44 rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-2xl"
        style={{ left, top }}
        onKeyDown={handleKeyDown}
      >
        {items.map(item => (
          <button
            key={item.tool}
            type="button"
            role="menuitemradio"
            aria-checked={selected === item.tool}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised"
            onClick={() => onSelect(item.tool)}
          >
            <span className="text-secondary">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {selected === item.tool && <CheckIcon className="h-4 w-4 text-primary" />}
          </button>
        ))}
      </div>
    </>,
    ownerDocument.body,
  );
}
