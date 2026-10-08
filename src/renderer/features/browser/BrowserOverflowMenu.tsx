import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CameraIcon,
  CircleStackIcon,
  ClockIcon,
  Cog6ToothIcon,
  DevicePhoneMobileIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { isDomHTMLElement, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

export type BrowserOverflowAction =
  | 'pdf-viewer'
  | 'find'
  | 'print'
  | 'device-tools'
  | 'screenshot'
  | 'import-data'
  | 'downloads'
  | 'history'
  | 'clear-data'
  | 'settings';

export default function BrowserOverflowMenu({
  anchor,
  zoomFactor,
  onAction,
  onZoomChange,
  onDismiss,
  disabledActions = [],
  disabledActionHint,
  pdfCompatibilityMode,
}: {
  anchor: { left: number; right: number; top: number; bottom: number };
  zoomFactor: number;
  onAction: (action: BrowserOverflowAction) => void;
  onZoomChange: (factor: number) => void;
  onDismiss: () => void;
  disabledActions?: readonly BrowserOverflowAction[];
  disabledActionHint?: string;
  pdfCompatibilityMode?: boolean;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  const iconClass = 'h-4 w-4 shrink-0 text-secondary';
  const items: Array<{
    action: BrowserOverflowAction;
    label: string;
    icon: React.ReactNode;
    trailing?: React.ReactNode;
  }> = [
    {
      action: 'pdf-viewer',
      label: i18nService.t(pdfCompatibilityMode ? 'browserPdfUseNative' : 'browserPdfUseCompatibility'),
      icon: <ArrowPathIcon className={iconClass} />,
    },
    {
      action: 'find',
      label: i18nService.t('browserMenuFind'),
      icon: <MagnifyingGlassIcon className={iconClass} />,
    },
    {
      action: 'print',
      label: i18nService.t('browserMenuPrint'),
      icon: <PrinterIcon className={iconClass} />,
    },
    {
      action: 'device-tools',
      label: i18nService.t('browserMenuDeviceTools'),
      icon: <DevicePhoneMobileIcon className={iconClass} />,
    },
    {
      action: 'screenshot',
      label: i18nService.t('browserMenuScreenshot'),
      icon: <CameraIcon className={iconClass} />,
    },
    {
      action: 'import-data',
      label: i18nService.t('browserMenuImportData'),
      icon: <CircleStackIcon className={iconClass} />,
    },
    {
      action: 'downloads',
      label: i18nService.t('browserMenuDownloads'),
      icon: <ArrowDownTrayIcon className={iconClass} />,
    },
    {
      action: 'history',
      label: i18nService.t('browserMenuHistory'),
      icon: <ClockIcon className={iconClass} />,
    },
    {
      action: 'clear-data',
      label: i18nService.t('browserMenuClearData'),
      icon: <TrashIcon className={iconClass} />,
    },
    {
      action: 'settings',
      label: i18nService.t('browserMenuSettings'),
      icon: <Cog6ToothIcon className={iconClass} />,
    },
  ];
  const left = Math.max(8, Math.min(anchor.right - 256, ownerWindow.innerWidth - 264));
  const top = Math.max(8, Math.min(anchor.bottom + 6, ownerWindow.innerHeight - 548));
  const zoomPercent = Math.round(zoomFactor * 100);

  useEffect(() => {
    const trigger = isDomHTMLElement(ownerDocument.activeElement) ? ownerDocument.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => trigger?.focus();
  }, [ownerDocument]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled):not([tabindex="-1"])',
      ) ?? []),
    ];
    if (!buttons.length) return;
    const currentIndex = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  const renderItem = (action: BrowserOverflowAction) => {
    const item = items.find(candidate => candidate.action === action)!;
    return (
      <button
        disabled={disabledActions.includes(action)}
        title={
          disabledActions.includes(action)
            ? disabledActionHint ?? i18nService.t('browserPdfActionUnavailable')
            : undefined
        }
        key={action}
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-raised focus:bg-surface-raised focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => onAction(action)}
      >
        {item.icon}
        <span className="min-w-0 flex-1">{item.label}</span>
        {item.trailing}
      </button>
    );
  };

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[109] cursor-default"
        aria-label={i18nService.t('browserMenuDismiss')}
        onClick={onDismiss}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={i18nService.t('browserMenuLabel')}
        className="fixed z-[110] w-64 overflow-y-auto rounded-xl border border-border bg-background p-1.5 text-foreground shadow-2xl"
        style={{ left, top, maxHeight: 'calc(100vh - 16px)' }}
        onKeyDown={handleKeyDown}
      >
        {renderItem('find')}
        {renderItem('print')}
        {pdfCompatibilityMode !== undefined && renderItem('pdf-viewer')}
        <div className="my-1 border-t border-border pt-1">
          <div className="flex items-center gap-3 rounded-md px-2.5 py-1.5 text-sm">
            <span className="min-w-0 flex-1">{i18nService.t('browserMenuZoom')}</span>
            <div className="flex items-center rounded-lg border border-border bg-surface-raised">
              <button
                type="button"
                className="rounded-l-lg p-1.5 text-secondary hover:bg-surface hover:text-foreground disabled:opacity-35"
                disabled={zoomFactor <= 0.5}
                aria-label={i18nService.t('browserMenuZoomOut')}
                onClick={() => onZoomChange(Math.max(0.5, zoomFactor - 0.1))}
              >
                <MinusIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="min-w-12 border-x border-border px-1.5 py-1 text-xs tabular-nums hover:bg-surface"
                aria-label={i18nService.t('browserMenuZoomReset')}
                onClick={() => onZoomChange(1)}
              >
                {zoomPercent}%
              </button>
              <button
                type="button"
                className="rounded-r-lg p-1.5 text-secondary hover:bg-surface hover:text-foreground disabled:opacity-35"
                disabled={zoomFactor >= 2}
                aria-label={i18nService.t('browserMenuZoomIn')}
                onClick={() => onZoomChange(Math.min(2, zoomFactor + 0.1))}
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              tabIndex={-1}
              className="rounded p-1 text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-35"
              disabled={zoomPercent === 100}
              aria-label={i18nService.t('browserMenuZoomReset')}
              onClick={() => onZoomChange(1)}
            >
              <ArrowPathIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        {renderItem('device-tools')}
        {renderItem('screenshot')}
        <div className="my-1 border-t border-border pt-1">
          {renderItem('import-data')}
          {renderItem('downloads')}
          {renderItem('history')}
          {renderItem('clear-data')}
        </div>
        <div className="mt-1 border-t border-border pt-1">{renderItem('settings')}</div>
      </div>
    </>,
    ownerDocument.body,
  );
}
