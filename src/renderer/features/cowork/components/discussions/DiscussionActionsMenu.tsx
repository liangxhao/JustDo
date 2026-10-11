import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  Cog6ToothIcon,
  EllipsisHorizontalIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';

export default function DiscussionActionsMenu({
  onSettings,
  onExport,
  onDelete,
  onSummarize,
  summarizeDisabled = false,
  exportDisabled = false,
  busy = false,
  compact = false,
}: {
  onSettings?: () => void;
  onExport?: () => void;
  onDelete?: () => void;
  onSummarize?: () => void;
  summarizeDisabled?: boolean;
  exportDisabled?: boolean;
  busy?: boolean;
  compact?: boolean;
}) {
  const ownerDocument = useOwnerDocument();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const t = i18nService.t.bind(i18nService);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    ownerDocument.addEventListener('pointerdown', close);
    return () => ownerDocument.removeEventListener('pointerdown', close);
  }, [open, ownerDocument]);
  const choose = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };
  return (
    <div
      ref={root}
      className="relative shrink-0"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={t('teamMore')}
        title={t('teamMore')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          compact
            ? 'flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary'
            : 'rounded-lg p-2 text-secondary hover:bg-surface-raised'
        }
        onClick={() => setOpen(!open)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <EllipsisHorizontalIcon className={compact ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={t('teamMore')}
          className="absolute right-0 top-full z-50 mt-1 w-40 rounded-xl border border-border bg-surface p-1 shadow-lg"
          onKeyDown={event => {
            const options = Array.from(
              menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
            );
            if (!options.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            const current = options.indexOf(ownerDocument.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                    options.length;
            options[next]?.focus();
          }}
        >
          {onSettings && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised"
              onClick={() => choose(onSettings)}
            >
              <Cog6ToothIcon className="h-4 w-4" />
              {t('agentTeamLocalSettings')}
            </button>
          )}
          {onExport && (
            <button
              type="button"
              role="menuitem"
              disabled={exportDisabled || busy}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised disabled:opacity-40"
              onClick={() => choose(onExport)}
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              {t('teamExport')}
            </button>
          )}
          {onSummarize && (
            <button
              type="button"
              role="menuitem"
              disabled={summarizeDisabled || busy}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised disabled:opacity-40"
              onClick={() => choose(onSummarize)}
            >
              <ArrowPathIcon className="h-4 w-4" />
              {t('teamSummarizeInSource')}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-500 hover:bg-surface-raised disabled:opacity-40"
              onClick={() => choose(onDelete)}
            >
              <TrashIcon className="h-4 w-4" />
              {t('teamDelete')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
