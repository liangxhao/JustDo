import type { RefObject } from 'react';

import {
  type SlashCommandCategory,
  SlashCommandCategoryLabels,
  type SlashCommandDef,
} from './slashCommands';

interface SlashCommandMenuProps {
  menuRef: RefObject<HTMLDivElement>;
  mode: 'command' | 'args';
  command: SlashCommandDef | null;
  argItems: string[];
  selectedIndex: number;
  groupedItems: Array<[SlashCommandCategory, Array<{ command: SlashCommandDef; index: number }>]>;
  hiddenCommandCount: number;
  onSelectArgument: (argument: string, execute: boolean) => void;
  onSelectCommand: (command: SlashCommandDef, execute: boolean) => void;
  onHighlight: (index: number) => void;
  onExpand: () => void;
}

export function SlashCommandMenu({
  menuRef,
  mode,
  command,
  argItems,
  selectedIndex,
  groupedItems,
  hiddenCommandCount,
  onSelectArgument,
  onSelectCommand,
  onHighlight,
  onExpand,
}: SlashCommandMenuProps) {
  return (
    <div
      ref={menuRef}
      className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface p-1.5 shadow-elevated"
      role="listbox"
      aria-label="Slash commands"
    >
      {mode === 'args' && command ? (
        <div>
          <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-primary/75">
            /{command.name} {command.description}
          </div>
          {argItems.map((arg, index) => (
            <button
              key={arg}
              type="button"
              onClick={() => onSelectArgument(arg, false)}
              onMouseEnter={() => onHighlight(index)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                index === selectedIndex ? 'bg-primary-muted' : 'hover:bg-surface-raised'
              }`}
              role="option"
              aria-selected={index === selectedIndex}
            >
              <span className="font-mono text-sm font-semibold text-primary">{arg}</span>
              <span className="min-w-0 flex-1 truncate text-right text-xs text-secondary">
                /{command.name} {arg}
              </span>
            </button>
          ))}
          <div className="mt-1 border-t border-border px-2.5 py-1.5 text-[11px] text-secondary">
            ↑↓ navigate · Tab fill · Enter run · Esc close
          </div>
        </div>
      ) : (
        <>
          {groupedItems.map(([category, entries]) => (
            <div
              key={category}
              className="border-border pt-1 first:pt-0 [&:not(:first-child)]:mt-1 [&:not(:first-child)]:border-t"
            >
              <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-primary/75">
                {SlashCommandCategoryLabels[category]}
              </div>
              {entries.map(({ command, index }) => (
                <button
                  key={command.key}
                  type="button"
                  onClick={() => onSelectCommand(command, true)}
                  onMouseEnter={() => onHighlight(index)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                    index === selectedIndex ? 'bg-primary-muted' : 'hover:bg-surface-raised'
                  }`}
                  role="option"
                  aria-selected={index === selectedIndex}
                >
                  <span className="font-mono text-sm font-semibold text-primary">
                    /{command.name}
                  </span>
                  {command.args && (
                    <span className="font-mono text-xs text-secondary/70">{command.args}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-secondary">
                    {command.description}
                  </span>
                  {command.argOptions?.length ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                      {command.argOptions.length} options
                    </span>
                  ) : command.executeLocal && !command.args ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                      instant
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {hiddenCommandCount > 0 && (
            <button
              type="button"
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                onExpand();
              }}
              className="mt-1 w-full border-t border-border px-2.5 py-2 text-center text-xs font-semibold text-primary hover:bg-primary/10"
            >
              Show {hiddenCommandCount} more command{hiddenCommandCount !== 1 ? 's' : ''}
            </button>
          )}
          <div className="mt-1 border-t border-border px-2.5 py-1.5 text-[11px] text-secondary">
            ↑↓ navigate · Tab fill · Enter select · Esc close
          </div>
        </>
      )}
    </div>
  );
}
