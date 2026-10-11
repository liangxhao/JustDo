import { ChevronDownIcon, ClockIcon, ShareIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { isDomNode, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

import type { AgentTeamEntry } from '../display/agentTeamEntries';
import AgentTeamRecordSummary from '../display/AgentTeamRecordSummary';

export default function AgentTeamMenu({
  entries,
  onSelect,
  onHistory,
}: {
  entries: readonly AgentTeamEntry[];
  onSelect: (entry: AgentTeamEntry) => void;
  onHistory?: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!entries.length && !onHistory) close();
  }, [entries.length, onHistory, close]);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(320, ownerWindow.innerWidth - 16);
    const top = Math.min(anchor.bottom + 6, Math.max(8, ownerWindow.innerHeight - 80));
    setPosition({
      left: Math.max(8, Math.min(anchor.right - width, ownerWindow.innerWidth - width - 8)),
      top,
      width,
      maxHeight: Math.min(400, ownerWindow.innerHeight - top - 8),
    });
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[focusLast.current ? items.length - 1 : 0]?.focus();
  }, [open, ownerWindow]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (
        isDomNode(target) &&
        !trigger.current?.contains(target) &&
        !menu.current?.contains(target)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        close(true);
      }
    };
    const resize = () => close();
    const scroll = (event: Event) => {
      if (isDomNode(event.target) && menu.current?.contains(event.target)) return;
      close();
    };
    ownerDocument.addEventListener('pointerdown', outside, true);
    ownerDocument.addEventListener('focusin', outside);
    ownerDocument.addEventListener('keydown', escape);
    ownerWindow.addEventListener('resize', resize);
    ownerWindow.addEventListener('scroll', scroll, true);
    return () => {
      ownerDocument.removeEventListener('pointerdown', outside, true);
      ownerDocument.removeEventListener('focusin', outside);
      ownerDocument.removeEventListener('keydown', escape);
      ownerWindow.removeEventListener('resize', resize);
      ownerWindow.removeEventListener('scroll', scroll, true);
    };
  }, [open, close, ownerDocument, ownerWindow]);
  if (!entries.length && !onHistory) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={i18nService.t('teamRecords')}
        aria-label={i18nService.t('teamTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="non-draggable inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-secondary hover:bg-surface-raised hover:text-foreground"
        onMouseDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          if (!entries.length && onHistory) {
            onHistory();
            return;
          }
          focusLast.current = false;
          setOpen(!open);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!entries.length && onHistory) {
              onHistory();
              return;
            }
            focusLast.current = event.key === 'ArrowUp';
            if (open) {
              const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
              items?.[focusLast.current ? items.length - 1 : 0]?.focus();
            } else setOpen(true);
          }
        }}
      >
        <ShareIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        <span>{i18nService.t('teamTitle')}</span>
        {entries.length > 0 && <span className="text-[10px] tabular-nums">{entries.length}</span>}
        <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            id={menuId}
            ref={menu}
            role="menu"
            aria-label={i18nService.t('teamRecords')}
            className="non-draggable fixed z-[100] overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 shadow-xl"
            style={position}
            onKeyDown={event => {
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                }
                close(true);
                return;
              }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
              );
              const index = items.indexOf(ownerDocument.activeElement as HTMLButtonElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            <p className="px-3 py-2 text-xs font-medium text-secondary">
              {i18nService.t('teamCurrentRecords')}
            </p>
            {entries.map(entry => {
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  title={entry.label}
                  className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-surface-raised focus:bg-surface-raised focus:outline-none"
                  onClick={() => {
                    close(true);
                    onSelect(entry);
                  }}
                >
                  <AgentTeamRecordSummary entry={entry} />
                </button>
              );
            })}
            {onHistory && (
              <div className="mt-1 border-t border-border-subtle pt-1">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-xs text-secondary hover:bg-surface-raised focus:bg-surface-raised focus:outline-none"
                  onClick={() => {
                    close(true);
                    onHistory();
                  }}
                >
                  <ClockIcon className="h-4 w-4" aria-hidden="true" />
                  {i18nService.t('teamAllRecords')}
                </button>
              </div>
            )}
          </div>,
          ownerDocument.body,
        )}
    </>
  );
}
