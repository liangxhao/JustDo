import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { useOwnerDocument } from '@/shared/dom/ownerDocument';

export interface ComposerFeatureItem {
  id: string;
  label: string;
  description?: string;
  section?: string;
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children?: readonly ComposerFeatureItem[];
  role?: 'menuitem' | 'menuitemradio';
}

/** Menu mechanics only; feature registration, draft state and execution belong to callers. */
export default function ComposerFeatureMenu({
  items,
  label,
  disabled = false,
  triggerIcon,
  backLabel,
  onOpen,
}: {
  items: readonly ComposerFeatureItem[];
  label: string;
  disabled?: boolean;
  triggerIcon?: ReactNode;
  backLabel?: string;
  onOpen?: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const [path, setPath] = useState<string[]>([]);
  let parent: ComposerFeatureItem | undefined;
  let entries = items;
  for (const id of path) {
    const next = entries.find(item => item.id === id && !item.disabled && item.children?.length);
    if (!next) {
      parent = undefined;
      break;
    }
    parent = next;
    entries = next.children!;
  }
  const visibleItems = parent ? entries : items;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | undefined>(undefined);
  const enterFromEnd = useRef(false);
  const itemsRef = useRef(visibleItems);
  itemsRef.current = visibleItems;
  const navigationKey = JSON.stringify([
    path,
    visibleItems.map(item => [item.id, Boolean(item.disabled)]),
  ]);
  useEffect(() => {
    if (disabled || !itemsRef.current.length) {
      setOpen(false);
      return;
    }
    if (!open) return;
    const enabled = itemsRef.current.filter(item => !item.disabled);
    const entry =
      enabled.find(item => item.id === returnFocus.current) ??
      (enterFromEnd.current ? enabled[enabled.length - 1] : enabled[0]);
    returnFocus.current = undefined;
    if (!enabled.some(item => buttons.current.get(item.id) === ownerDocument.activeElement)) {
      if (entry) buttons.current.get(entry.id)?.focus();
      else (back.current ?? trigger.current)?.focus();
    }
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    ownerDocument.addEventListener('pointerdown', dismiss);
    ownerDocument.addEventListener('keydown', escape);
    return () => {
      ownerDocument.removeEventListener('pointerdown', dismiss);
      ownerDocument.removeEventListener('keydown', escape);
    };
  }, [open, disabled, navigationKey, ownerDocument]);
  const goBack = () => {
    returnFocus.current = parent?.id;
    setPath(current => current.slice(0, -1));
  };
  const navigate = (id: string, key: string) => {
    const enabled = visibleItems.filter(item => !item.disabled);
    if (!enabled.length) return;
    const index = enabled.findIndex(item => item.id === id);
    const next =
      key === 'Home'
        ? 0
        : key === 'End'
          ? enabled.length - 1
          : (index + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    buttons.current.get(enabled[next].id)?.focus();
  };
  if (!items.length) return null;
  return (
    <div
      ref={root}
      className="relative"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        disabled={disabled || !items.length}
        title={label}
        aria-label={label}
        aria-expanded={open && !disabled}
        aria-haspopup="menu"
        aria-controls={open && !disabled ? menuId : undefined}
        onClick={() => {
          if (!open) onOpen?.();
          enterFromEnd.current = false;
          setPath([]);
          setOpen(!open);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!open) onOpen?.();
            event.preventDefault();
            enterFromEnd.current = event.key === 'ArrowUp';
            setPath([]);
            setOpen(true);
          }
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-transparent text-secondary transition-colors hover:text-foreground disabled:opacity-40"
      >
        <span aria-hidden="true">{triggerIcon ?? <PlusIcon className="h-4 w-4" />}</span>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          id={menuId}
          aria-label={parent?.label ?? label}
          className="absolute bottom-full left-0 z-50 mb-2 max-h-[min(360px,calc(100dvh-160px))] w-96 max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 shadow-elevated"
        >
          {parent && (
            <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1">
              <span className="min-w-0 truncate text-xs text-secondary">{parent.label}</span>
              <button
                ref={back}
                type="button"
                title={backLabel ?? parent.label}
                aria-label={backLabel ?? parent.label}
                onClick={goBack}
                onKeyDown={event => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    goBack();
                  } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    navigate(
                      '',
                      event.key === 'ArrowUp'
                        ? 'End'
                        : event.key === 'ArrowDown'
                          ? 'Home'
                          : event.key,
                    );
                  }
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus:bg-surface-raised focus:outline-none"
              >
                <ChevronLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {visibleItems.map((item, index) => (
            <Fragment key={item.id}>
              {(!parent || item.section) &&
                (index === 0 || item.section !== visibleItems[index - 1].section) && (
                  <div
                    role="presentation"
                    className={`px-2 pb-1 pt-1 text-xs text-secondary ${index > 0 ? 'mt-2' : ''}`}
                  >
                    {item.section ?? parent?.label ?? label}
                  </div>
                )}
              <button
                ref={element => {
                  if (element) buttons.current.set(item.id, element);
                  else buttons.current.delete(item.id);
                }}
                type="button"
                role={item.role ?? 'menuitem'}
                aria-checked={item.role === 'menuitemradio' ? !!item.selected : undefined}
                aria-haspopup={item.children?.length ? 'menu' : undefined}
                aria-label={item.label}
                aria-describedby={item.description ? `${menuId}-${item.id}-description` : undefined}
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  if (item.children?.length) {
                    enterFromEnd.current = false;
                    setPath(current => (parent ? [...current, item.id] : [item.id]));
                    return;
                  }
                  setOpen(false);
                  trigger.current?.focus();
                  item.onSelect();
                }}
                onKeyDown={event => {
                  if (event.key === 'ArrowRight' && item.children?.length) {
                    event.preventDefault();
                    enterFromEnd.current = false;
                    setPath(current => (parent ? [...current, item.id] : [item.id]));
                  } else if (event.key === 'ArrowLeft' && parent) {
                    event.preventDefault();
                    goBack();
                  } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    navigate(item.id, event.key);
                  }
                }}
                className="flex w-full items-center gap-2 rounded-full px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-raised focus:bg-surface-raised focus:outline-none disabled:opacity-40"
              >
                <span
                  aria-hidden="true"
                  className="flex h-4 w-4 shrink-0 items-center text-secondary"
                >
                  {item.icon}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="max-w-full shrink-0 truncate font-medium">{item.label}</span>
                  {item.description && (
                    <span
                      id={`${menuId}-${item.id}-description`}
                      className="truncate text-sm text-secondary"
                    >
                      {item.description}
                    </span>
                  )}
                </span>
                {item.children?.length ? (
                  <ChevronRightIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                ) : (
                  item.selected && (
                    <CheckIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                  )
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
