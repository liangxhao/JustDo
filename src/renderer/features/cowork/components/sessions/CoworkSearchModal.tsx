import { XMarkIcon } from '@heroicons/react/24/outline';
import type { CoworkSessionMessageSearchMatch } from '@shared/cowork/sessionSearch';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import SearchIcon from '@/shared/components/icons/SearchIcon';

const normalizeSearchText = (value: string): string => value.trim().toLocaleLowerCase();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const terms = Array.from(new Set(query.trim().split(/\s+/u).filter(Boolean)))
    .sort((left, right) => right.length - left.length)
    .slice(0, 32);
  if (terms.length === 0) return <>{text}</>;
  const matcher = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu');
  return (
    <>
      {text.split(matcher).map((part, index) =>
        index % 2 === 1 ? (
          <mark
            // The index is stable because the source text and query define this split.
            key={`${index}:${part}`}
            className="rounded-sm bg-primary/20 px-0.5 text-inherit"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={`${index}:${part}`}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void | Promise<void>;
}

type SearchStatus = 'idle' | 'searching' | 'incomplete' | 'error';

const INDEX_RETRY_DELAYS = [500, 1_000, 2_000, 3_000, 3_000] as const;

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  onSelectSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [messageMatches, setMessageMatches] = useState<{
    query: string;
    matches: CoworkSessionMessageSearchMatch[];
  }>({ query: '', matches: [] });
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [searchRevision, setSearchRevision] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchResults = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery);
    const matchesBySessionId = new Map<string, CoworkSessionMessageSearchMatch>();
    if (messageMatches.query === normalizedQuery) {
      for (const match of messageMatches.matches) {
        if (!matchesBySessionId.has(match.sessionId)) {
          matchesBySessionId.set(match.sessionId, match);
        }
      }
    }
    const results = sessions.flatMap(session => {
      const normalizedTitle = session.title.toLocaleLowerCase();
      const titleRank = !normalizedQuery
        ? 0
        : normalizedTitle === normalizedQuery
          ? 3
          : normalizedTitle.startsWith(normalizedQuery)
            ? 2
            : normalizedTitle.includes(normalizedQuery)
              ? 1
              : 0;
      const messageMatch = matchesBySessionId.get(session.id);
      return !normalizedQuery || titleRank > 0 || messageMatch
        ? [{ session, messageMatch, titleRank }]
        : [];
    });
    if (!normalizedQuery) return results;
    return results.sort(
      (left, right) =>
        right.titleRank - left.titleRank ||
        (right.messageMatch?.score ?? Number.NEGATIVE_INFINITY) -
          (left.messageMatch?.score ?? Number.NEGATIVE_INFINITY) ||
        right.session.updatedAt - left.session.updatedAt,
    );
  }, [messageMatches, sessions, searchQuery]);

  useEffect(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!isOpen || !normalizedQuery) {
      setMessageMatches({ query: '', matches: [] });
      setSearchStatus('idle');
      return;
    }
    let cancelled = false;
    let retryTimeout: number | undefined;
    let attempt = 0;
    setSearchStatus('searching');
    const runSearch = async () => {
      try {
        const result = await window.electron.cowork.searchSessionMessages(searchQuery);
        if (cancelled) return;
        if (!result.success) {
          setSearchStatus('error');
          return;
        }
        setMessageMatches({
          query: normalizedQuery,
          matches: result.matches,
        });
        if (result.indexing && attempt < INDEX_RETRY_DELAYS.length) {
          const delay = INDEX_RETRY_DELAYS[attempt];
          attempt += 1;
          retryTimeout = window.setTimeout(runSearch, delay);
          return;
        }
        setSearchStatus(
          result.indexing || result.partial || result.truncated ? 'incomplete' : 'idle',
        );
      } catch {
        if (cancelled) return;
        setSearchStatus('error');
      }
    };
    const timeout = window.setTimeout(runSearch, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (retryTimeout !== undefined) window.clearTimeout(retryTimeout);
    };
  }, [isOpen, searchQuery, searchRevision]);

  useEffect(() => {
    setActiveIndex(null);
  }, [searchQuery]);

  useEffect(() => {
    setActiveIndex(index =>
      index === null ? null : Math.min(index, Math.max(0, searchResults.length - 1)),
    );
  }, [searchResults.length]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectSession = async (sessionId: string) => {
    await onSelectSession(sessionId);
    onClose();
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (searchResults.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => {
        if (index === null) return direction > 0 ? 0 : searchResults.length - 1;
        return (index + direction + searchResults.length) % searchResults.length;
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = searchResults[activeIndex ?? 0];
      if (result) void handleSelectSession(result.session.id);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      className="modal-content w-full max-w-2xl mt-10 rounded-2xl border border-border bg-surface shadow-modal overflow-hidden"
    >
      <div role="dialog" aria-modal="true" aria-label={i18nService.t('search')}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              type="search"
              maxLength={4096}
              ref={searchInputRef}
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label={i18nService.t('searchConversations')}
              aria-controls="cowork-search-results"
              aria-activedescendant={
                activeIndex === null ? undefined : `cowork-search-result-${activeIndex}`
              }
              placeholder={i18nService.t('searchConversations')}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="px-3 py-3 max-h-[60vh] overflow-y-auto">
          {searchStatus === 'searching' && searchResults.length === 0 ? (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('searchingConversations')}
            </div>
          ) : searchResults.length === 0 &&
            (searchStatus === 'incomplete' || searchStatus === 'error') ? (
            <div
              className="flex flex-col items-center gap-3 py-10 text-center text-sm text-secondary"
              role="status"
              aria-live="polite"
            >
              <span>
                {i18nService.t(
                  searchStatus === 'error'
                    ? 'searchConversationsFailed'
                    : 'searchConversationsIncomplete',
                )}
              </span>
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => setSearchRevision(revision => revision + 1)}
              >
                {i18nService.t('searchConversationsRetry')}
              </button>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('searchNoResults')}
            </div>
          ) : (
            <ul
              id="cowork-search-results"
              className="space-y-1"
              aria-label={i18nService.t('search')}
            >
              {searchResults.map(({ session, messageMatch }, index) => (
                <li key={session.id}>
                  <button
                    id={`cowork-search-result-${index}`}
                    type="button"
                    onClick={() => handleSelectSession(session.id)}
                    aria-current={session.id === currentSessionId ? 'page' : undefined}
                    className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                      index === activeIndex
                        ? 'bg-primary/[0.12] ring-1 ring-inset ring-primary/25'
                        : 'hover:bg-primary/[0.08] hover:ring-1 hover:ring-inset hover:ring-primary/20'
                    }`}
                  >
                    <div className="truncate text-sm font-medium text-foreground">
                      <HighlightedText text={session.title} query={searchQuery} />
                    </div>
                    {messageMatch && (
                      <div className="mt-1 truncate text-xs leading-5 text-secondary">
                        <HighlightedText text={messageMatch.snippet} query={searchQuery} />
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {searchQuery.trim() && searchResults.length > 0 && searchStatus === 'searching' && (
            <div className="px-3 pt-3 text-xs text-secondary" role="status" aria-live="polite">
              {i18nService.t('searchingConversations')}
            </div>
          )}
          {searchResults.length > 0 &&
            (searchStatus === 'incomplete' || searchStatus === 'error') && (
              <div
                className="flex items-center justify-between gap-3 px-3 pt-3 text-xs text-secondary"
                role="status"
                aria-live="polite"
              >
                <span>
                  {i18nService.t(
                    searchStatus === 'error'
                      ? 'searchConversationsFailed'
                      : 'searchConversationsIncomplete',
                  )}
                </span>
                <button
                  type="button"
                  className="shrink-0 font-medium text-primary hover:underline"
                  onClick={() => setSearchRevision(revision => revision + 1)}
                >
                  {i18nService.t('searchConversationsRetry')}
                </button>
              </div>
            )}
        </div>
      </div>
    </Modal>
  );
};

export default CoworkSearchModal;
