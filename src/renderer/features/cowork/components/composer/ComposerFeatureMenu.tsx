import { CheckIcon, PlusIcon } from '@heroicons/react/24/outline';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface ComposerFeatureItem {
  id: string;
  label: string;
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
}: {
  items: readonly ComposerFeatureItem[];
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const enterFromEnd = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!open) return;
    const enabled = itemsRef.current.filter(item => !item.disabled);
    const entry = enterFromEnd.current ? enabled[enabled.length - 1] : enabled[0];
    if (entry) buttons.current.get(entry.id)?.focus();
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
  }, [open, disabled]);
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
        className={`flex h-7 items-center gap-1 rounded-lg px-1.5 disabled:opacity-40 ${items.some(item => item.selected) ? 'bg-primary/10 text-primary' : 'text-secondary hover:bg-surface-raised'}`}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
      {open && !disabled && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-full left-0 z-50 mb-2 w-48 rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {items.map(item => (
            <button
              key={item.id}
              ref={element => {
                if (element) buttons.current.set(item.id, element);
                else buttons.current.delete(item.id);
              }}
              type="button"
              role="menuitem"
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
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-surface-raised focus:bg-surface-raised focus:outline-none disabled:opacity-40"
            >
              <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center text-primary">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">{item.label}</span>
              {item.selected && (
                <CheckIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
