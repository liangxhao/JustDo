import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

import {
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  resizeComposerTextarea,
} from '../composer/composerStyles';

export default forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    members: readonly { agentId: string; name: string; deleted?: boolean }[];
    selected: readonly string[];
    onSelected: (ids: string[]) => void;
    disabled: boolean;
    recipientsDisabled: boolean;
    className: string;
  }
>(function DiscussionMentionInput(
  { value, onChange, members, selected, onSelected, disabled, recipientsDisabled, className },
  ref,
) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const input = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (input.current) resizeComposerTextarea(input.current);
  }, [value]);
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [index, setIndex] = useState(0);
  const composing = useRef(false);
  const t = i18nService.t.bind(i18nService);
  const choices = members.filter(
    member =>
      !member.deleted &&
      !selected.includes(member.agentId) &&
      (member.name.toLocaleLowerCase().includes(query?.text.toLocaleLowerCase() ?? '') ||
        member.agentId.toLocaleLowerCase().includes(query?.text.toLocaleLowerCase() ?? '')),
  );
  const open = !!query && !disabled && !recipientsDisabled;
  const activeIndex = Math.min(index, Math.max(0, choices.length - 1));
  useEffect(() => {
    if (open)
      ownerDocument
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId, open, ownerDocument]);
  const updateQuery = (field: HTMLTextAreaElement) => {
    if (composing.current || field.selectionStart !== field.selectionEnd) {
      setQuery(null);
      return;
    }
    const before = field.value.slice(0, field.selectionStart);
    const match = /(?:^|[^A-Za-z0-9_.+-])@([^\s@]*)$/u.exec(before);
    setQuery(match ? { start: before.lastIndexOf('@'), end: before.length, text: match[1] } : null);
    setIndex(0);
  };
  const choose = (id: string) => {
    if (!query || disabled || recipientsDisabled) return;
    onSelected([...new Set([...selected, id])]);
    onChange(value.slice(0, query.start) + value.slice(query.end));
    const caret = query.start;
    setQuery(null);
    ownerWindow.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <div className="relative space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label={t('teamRecipients')}>
          {selected.map(id => (
            <button
              key={id}
              type="button"
              disabled={disabled || recipientsDisabled}
              aria-label={`${t('teamMentionRemove')} ${members.find(member => member.agentId === id)?.name ?? id}`}
              className="rounded-lg border border-border px-2 py-1 text-sm text-primary"
              onClick={() => onSelected(selected.filter(value => value !== id))}
            >
              @{members.find(member => member.agentId === id)?.name ?? id} ×
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label={t('teamMentionSuggestions')}
            className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-64 max-w-full overflow-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
          >
            {choices.length ? (
              choices.map((member, position) => (
                <button
                  key={member.agentId}
                  id={`${listId}-${position}`}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === position}
                  tabIndex={-1}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => choose(member.agentId)}
                  className="flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-raised aria-selected:bg-surface-raised"
                >
                  <span>{member.name}</span>
                  <span className="text-xs text-secondary">{member.agentId}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-secondary">{t('teamMentionNoMatches')}</p>
            )}
          </div>
        )}
        <textarea
          ref={element => {
            input.current = element;
            if (typeof ref === 'function') ref(element);
            else if (ref) ref.current = element;
          }}
          aria-label={t('teamMessage')}
          placeholder={t('teamMentionPlaceholder')}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && choices.length ? `${listId}-${activeIndex}` : undefined}
          className={className}
          rows={2}
          style={{
            minHeight: COMPOSER_TEXTAREA_MIN_HEIGHT,
            maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
          }}
          maxLength={16000}
          value={value}
          disabled={disabled}
          onChange={event => {
            onChange(event.target.value);
            updateQuery(event.target);
          }}
          onSelect={event => {
            if (query) updateQuery(event.currentTarget);
          }}
          onClick={event => updateQuery(event.currentTarget)}
          onBlur={() => setQuery(null)}
          onCompositionStart={() => {
            composing.current = true;
            setQuery(null);
          }}
          onCompositionEnd={event => {
            composing.current = false;
            updateQuery(event.currentTarget);
          }}
          onKeyDown={event => {
            if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setQuery(null);
            } else if (choices.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault();
              setIndex(
                (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) %
                  choices.length,
              );
            } else if (choices.length && ['Enter', 'Tab'].includes(event.key)) {
              event.preventDefault();
              choose(choices[activeIndex].agentId);
            }
          }}
        />
      </div>
    </div>
  );
});
