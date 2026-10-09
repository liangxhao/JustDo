import { CheckIcon, PlusIcon } from '@heroicons/react/24/outline';
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from 'react';

export interface ComposerFeatureItem {
  id: string;
  label: string;
  description?: string;
  section?: string;
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Menu mechanics only; feature registration, draft state and execution belong to callers. */
export default function ComposerFeatureMenu({
  items,
  label,
  disabled = false,
  triggerIcon,
}: {
  items: readonly ComposerFeatureItem[];
  label: string;
  disabled?: boolean;
  triggerIcon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const enterFromEnd = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const navigationKey = JSON.stringify(items.map(item => [item.id, Boolean(item.disabled)]));
  useEffect(() => {
    if (disabled || !itemsRef.current.length) {
      setOpen(false);
      return;
    }
    if (!open) return;
    const enabled = itemsRef.current.filter(item => !item.disabled);
    const entry = enterFromEnd.current ? enabled[enabled.length - 1] : enabled[0];
    if (!enabled.some(item => buttons.current.get(item.id) === document.activeElement)) {
      if (entry) buttons.current.get(entry.id)?.focus();
      else trigger.current?.focus();
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
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open, disabled, navigationKey]);
  const navigate = (id: string, key: string) => {
    const enabled = items.filter(item => !item.disabled);
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
          enterFromEnd.current = false;
          setOpen(!open);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            enterFromEnd.current = event.key === 'ArrowUp';
            setOpen(true);
          }
        }}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-transparent transition-colors disabled:opacity-40 ${items.some(item => item.selected) ? 'text-primary' : 'text-secondary hover:text-foreground'}`}
      >
        <span aria-hidden="true">{triggerIcon ?? <PlusIcon className="h-4 w-4" />}</span>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          id={menuId}
          aria-label={label}
          className="absolute bottom-full left-0 z-50 mb-2 max-h-[min(360px,calc(100dvh-160px))] w-96 max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 shadow-elevated"
        >
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {(index === 0 || item.section !== items[index - 1].section) && (
                <div
                  role="presentation"
                  className={`px-2 pb-1 pt-1 text-xs text-secondary ${index > 0 ? 'mt-2' : ''}`}
                >
                  {item.section ?? label}
                </div>
              )}
              <button
                ref={element => {
                  if (element) buttons.current.set(item.id, element);
                  else buttons.current.delete(item.id);
                }}
                type="button"
                role="menuitem"
                aria-label={item.label}
                aria-describedby={item.description ? `${menuId}-${item.id}-description` : undefined}
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  item.onSelect();
                }}
                onKeyDown={event => {
                  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
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
                {item.selected && (
                  <CheckIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
