import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { isDomHTMLElement, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

export type BrowserTabMenuAction =
  | 'new-right'
  | 'reload'
  | 'duplicate'
  | 'copy-url'
  | 'open-external'
  | 'rename'
  | 'toggle-mute'
  | 'close'
  | 'close-others'
  | 'close-right';

type MenuItem = {
  action: BrowserTabMenuAction;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
};

export default function BrowserTabContextMenu({
  x,
  y,
  muted,
  copyAddressLabel,
  canCloseOthers,
  canCloseRight,
  onAction,
  onDismiss,
  onRestoreFocus,
}: {
  x: number;
  y: number;
  muted: boolean;
  copyAddressLabel?: string;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  onAction: (action: BrowserTabMenuAction) => void;
  onDismiss: () => void;
  onRestoreFocus?: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  const iconClass = 'h-4 w-4 shrink-0';
  const groups: MenuItem[][] = [
    [
      {
        action: 'new-right',
        label: i18nService.t('browserTabMenuNewRight'),
        icon: <PlusIcon className={iconClass} />,
      },
      {
        action: 'reload',
        label: i18nService.t('browserPanelReload'),
        icon: <ArrowPathIcon className={iconClass} />,
      },
      {
        action: 'duplicate',
        label: i18nService.t('browserTabMenuDuplicate'),
        icon: <DocumentDuplicateIcon className={iconClass} />,
      },
      {
        action: 'copy-url',
        label: copyAddressLabel || i18nService.t('browserTabMenuCopyUrl'),
        icon: <LinkIcon className={iconClass} />,
      },
      {
        action: 'open-external',
        label: i18nService.t('browserTabMenuOpenExternal'),
        icon: <ArrowTopRightOnSquareIcon className={iconClass} />,
      },
    ],
    [
      {
        action: 'rename',
        label: i18nService.t('rename'),
        icon: <PencilIcon className={iconClass} />,
      },
      {
        action: 'toggle-mute',
        label: i18nService.t(muted ? 'browserTabMenuUnmute' : 'browserTabMenuMute'),
        icon: muted ? (
          <SpeakerWaveIcon className={iconClass} />
        ) : (
          <SpeakerXMarkIcon className={iconClass} />
        ),
      },
    ],
    [
      {
        action: 'close',
        label: i18nService.t('browserPanelCloseTab'),
        icon: <XMarkIcon className={iconClass} />,
      },
      {
        action: 'close-others',
        label: i18nService.t('browserTabMenuCloseOthers'),
        icon: <XMarkIcon className={iconClass} />,
        disabled: !canCloseOthers,
      },
      {
        action: 'close-right',
        label: i18nService.t('browserTabMenuCloseRight'),
        icon: <XMarkIcon className={iconClass} />,
        disabled: !canCloseRight,
      },
    ],
  ];
  const left = Math.max(8, Math.min(x, ownerWindow.innerWidth - 232));
  const top = Math.max(8, Math.min(y, ownerWindow.innerHeight - 392));

  useEffect(() => {
    const trigger = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => trigger?.focus();
  }, [ownerDocument]);

  const dismissAndRestoreFocus = () => {
    onDismiss();
    if (onRestoreFocus) ownerWindow.requestAnimationFrame(onRestoreFocus);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      dismissAndRestoreFocus();
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
        className="fixed inset-0 z-[109] cursor-default"
        aria-label={i18nService.t('browserTabMenuDismiss')}
        onClick={dismissAndRestoreFocus}
        onContextMenu={event => {
          event.preventDefault();
          dismissAndRestoreFocus();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('browserTabMenuLabel')}
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
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised disabled:opacity-40"
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
