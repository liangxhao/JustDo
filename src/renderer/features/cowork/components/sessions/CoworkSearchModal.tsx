import './CoworkSearchModal.css';

import {
  ArrowPathIcon,
  ArrowTurnDownLeftIcon,
  ChatBubbleLeftRightIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MagnifyingGlassIcon as SearchIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { CoworkSessionMessageSearchMatch } from '@shared/cowork/sessionSearch';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { CoworkSessionSummary, SessionGroup } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

import { useDialogFocusTrap } from '../shared/useDialogFocusTrap';

const normalizeSearchText = (value: string): string =>
  value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const EMPTY_GROUPS: SessionGroup[] = [];

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
            className="cowork-search-highlight"
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
  groups?: SessionGroup[];
  onSelectSession: (
    sessionId: string,
    match?: CoworkSessionMessageSearchMatch,
  ) => boolean | void | Promise<boolean | void>;
}

type SearchStatus = 'idle' | 'searching' | 'error';
interface SearchSnapshot {
  query: string;
  scope: string;
  matches: CoworkSessionMessageSearchMatch[];
  indexing: boolean;
  partial: boolean;
  truncated: boolean;
  archivedTranscriptsExcluded: number;
}
const EMPTY_SEARCH: SearchSnapshot = {
  query: '',
  scope: '',
  matches: [],
  indexing: false,
  partial: false,
  truncated: false,
  archivedTranscriptsExcluded: 0,
};

const INDEX_RETRY_DELAYS = [500, 1_000, 2_000, 3_000, 3_000] as const;

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  groups = EMPTY_GROUPS,
  onSelectSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [messageMatches, setMessageMatches] = useState<SearchSnapshot>(EMPTY_SEARCH);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [searchRevision, setSearchRevision] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [composing, setComposing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const composingRef = useRef(false);
  const searchGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const selectingRef = useRef(false);
  const dialogGenerationRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultListRef = useRef<HTMLUListElement>(null);
  useDialogFocusTrap(dialogRef, searchInputRef, 'cowork-search', true, isOpen);
  const language = i18nService.getLanguage();
  const filteredSessions = useMemo(
    () =>
      sessions.filter(
        session => (!pinnedOnly || session.pinned) && (!groupId || session.groupId === groupId),
      ),
    [sessions, pinnedOnly, groupId],
  );
  const scope = JSON.stringify(filteredSessions.map(session => session.id).sort());
  const normalizedQuery = normalizeSearchText(searchQuery);
  const currentSearch =
    messageMatches.query === normalizedQuery && messageMatches.scope === scope
      ? messageMatches
      : EMPTY_SEARCH;
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    [language],
  );

  const searchResults = useMemo(() => {
    const matchesBySessionId = new Map<string, CoworkSessionMessageSearchMatch>();
    if (messageMatches.query === normalizedQuery && messageMatches.scope === scope) {
      for (const match of messageMatches.matches) {
        if (!matchesBySessionId.has(match.sessionId)) {
          matchesBySessionId.set(match.sessionId, match);
        }
      }
    }
    const results = filteredSessions.flatMap(session => {
      const normalizedTitle = normalizeSearchText(session.title);
      const titleRank = !normalizedQuery
        ? 0
        : normalizedTitle === normalizedQuery
          ? 3
          : normalizedTitle.startsWith(normalizedQuery)
            ? 2
            : normalizedQuery.split(' ').every(term => normalizedTitle.includes(term))
              ? 1
              : 0;
      const messageMatch = matchesBySessionId.get(session.id);
      return !normalizedQuery || titleRank > 0 || messageMatch
        ? [{ session, messageMatch, titleRank }]
        : [];
    });
    if (!normalizedQuery)
      return results.sort((left, right) => right.session.updatedAt - left.session.updatedAt);
    return results.sort(
      (left, right) =>
        right.titleRank - left.titleRank ||
        (right.messageMatch?.score ?? Number.NEGATIVE_INFINITY) -
          (left.messageMatch?.score ?? Number.NEGATIVE_INFINITY) ||
        right.session.updatedAt - left.session.updatedAt,
    );
  }, [messageMatches, filteredSessions, normalizedQuery, scope]);

  useEffect(() => {
    searchGenerationRef.current += 1;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!isOpen || !normalizedQuery || composing || filteredSessions.length === 0) {
      if (!normalizedQuery || !isOpen || filteredSessions.length === 0)
        setMessageMatches(EMPTY_SEARCH);
      setSearchStatus('idle');
      return;
    }
    let cancelled = false;
    let retryTimeout: number | undefined;
    let attempt = 0;
    setSearchStatus('searching');
    const runSearch = async () => {
      try {
        const result = await window.electron.cowork.searchSessionMessages(normalizedQuery, {
          sessionIds: JSON.parse(scope) as string[],
        });
        if (cancelled) return;
        if (!result.success) {
          setSearchStatus('error');
          return;
        }
        setMessageMatches({
          query: normalizedQuery,
          scope,
          matches: result.matches,
          indexing: result.indexing,
          partial: result.partial,
          truncated: result.truncated,
          archivedTranscriptsExcluded: result.archivedTranscriptsExcluded ?? 0,
        });
        if (result.indexing && attempt < INDEX_RETRY_DELAYS.length) {
          const delay = INDEX_RETRY_DELAYS[attempt];
          attempt += 1;
          retryTimeout = window.setTimeout(runSearch, delay);
          return;
        }
        setSearchStatus('idle');
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
  }, [isOpen, normalizedQuery, scope, searchRevision, composing, filteredSessions.length]);

  useEffect(() => {
    setActiveIndex(null);
  }, [searchQuery, scope]);

  useEffect(() => {
    setActiveIndex(index =>
      index === null || searchResults.length === 0
        ? null
        : Math.min(index, searchResults.length - 1),
    );
  }, [searchResults.length]);

  useEffect(() => {
    dialogGenerationRef.current += 1;
    if (!isOpen) {
      setSearchQuery('');
      setActiveIndex(null);
      composingRef.current = false;
      setComposing(false);
      setPinnedOnly(false);
      setGroupId('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (activeIndex === null) return;
    resultListRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !composingRef.current &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectSession = async (
    sessionId: string,
    match?: CoworkSessionMessageSearchMatch,
  ) => {
    if (selectingRef.current || composingRef.current) return;
    const generation = dialogGenerationRef.current;
    selectingRef.current = true;
    setSelecting(true);
    try {
      const selected = match
        ? await onSelectSession(sessionId, match)
        : await onSelectSession(sessionId);
      if (selected !== false && generation === dialogGenerationRef.current) onClose();
    } catch {
      if (generation === dialogGenerationRef.current) {
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('searchOpenFailed') }),
        );
      }
    } finally {
      selectingRef.current = false;
      setSelecting(false);
    }
  };

  const handleLoadMore = async () => {
    if (loadingMoreRef.current || searchStatus === 'searching' || composingRef.current) return;
    const generation = searchGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await window.electron.cowork.searchSessionMessages(normalizedQuery, {
        sessionIds: JSON.parse(scope) as string[],
        excludeSessionIds: currentSearch.matches.map(match => match.sessionId),
      });
      if (generation !== searchGenerationRef.current) return;
      if (!result.success) {
        setSearchStatus('error');
        return;
      }
      setMessageMatches(previous => ({
        ...previous,
        matches: Array.from(
          new Map(
            [...previous.matches, ...result.matches].map(match => [match.sessionId, match]),
          ).values(),
        ),
        indexing: previous.indexing || result.indexing,
        partial: previous.partial || result.partial,
        truncated: result.truncated,
        archivedTranscriptsExcluded: Math.max(
          previous.archivedTranscriptsExcluded,
          result.archivedTranscriptsExcluded ?? 0,
        ),
      }));
      setSearchStatus('idle');
    } catch {
      if (generation === searchGenerationRef.current) setSearchStatus('error');
    } finally {
      if (generation === searchGenerationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
      if (result) void handleSelectSession(result.session.id, result.messageMatch);
    }
  };

  if (!isOpen) return null;

  const hasQuery = Boolean(searchQuery.trim());
  const hasSearchNotice =
    currentSearch.partial || currentSearch.indexing || searchStatus === 'error';
  const searchNotice = i18nService.t(
    searchStatus === 'error'
      ? 'searchConversationsFailed'
      : currentSearch.indexing
        ? 'searchIndexingConversations'
        : 'searchConversationsIncomplete',
  );

  return (
    <Modal
      onClose={onClose}
      overlayClassName="modal-backdrop cowork-search-overlay"
      className="modal-content cowork-search-panel"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cowork-search-title"
        aria-describedby="cowork-search-description"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div className="cowork-search-header">
          <div className="mb-3 flex items-start gap-2.5">
            <div className="cowork-search-brand" aria-hidden="true">
              <SearchIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="cowork-search-title" className="text-sm font-semibold text-foreground">
                {i18nService.t('searchDialogTitle')}
              </h2>
              <p
                id="cowork-search-description"
                className="mt-0.5 text-[11px] leading-4 text-secondary"
              >
                {i18nService.t('searchDialogDescription')}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="cowork-search-icon-button -mr-1 -mt-1"
              aria-label={i18nService.t('close')}
              title={i18nService.t('close')}
            >
              <XMarkIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
          <div className="cowork-search-field">
            <SearchIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <input
              type="search"
              maxLength={4096}
              ref={searchInputRef}
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
                setComposing(true);
              }}
              onCompositionEnd={event => {
                composingRef.current = false;
                setComposing(false);
                setSearchQuery(event.currentTarget.value);
              }}
              aria-label={i18nService.t('searchConversations')}
              aria-controls="cowork-search-results"
              aria-activedescendant={
                activeIndex === null ? undefined : `cowork-search-result-${activeIndex}`
              }
              placeholder={i18nService.t('searchConversations')}
              className="cowork-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="cowork-search-icon-button shrink-0"
                aria-label={i18nService.t('searchClearQuery')}
                title={i18nService.t('searchClearQuery')}
                onClick={() => {
                  setSearchQuery('');
                  searchInputRef.current?.focus();
                }}
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            )}
            <span className="hidden sm:inline-flex" aria-hidden="true">
              <kbd className="cowork-search-key">Esc</kbd>
            </span>
          </div>
          <div className="cowork-search-filters">
            <button
              type="button"
              className="cowork-search-filter"
              aria-pressed={!pinnedOnly}
              onClick={() => setPinnedOnly(false)}
            >
              {i18nService.t('searchScopeAll')}
            </button>
            <button
              type="button"
              className="cowork-search-filter"
              aria-pressed={pinnedOnly}
              onClick={() => setPinnedOnly(true)}
            >
              {i18nService.t('searchScopePinned')}
            </button>
            {groups.length > 0 && (
              <select
                className="cowork-search-group"
                aria-label={i18nService.t('searchScopeGroup')}
                value={groupId}
                onChange={event => setGroupId(event.target.value)}
              >
                <option value="">{i18nService.t('searchScopeAllGroups')}</option>
                {groups.map(group => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1.5 pt-2.5 text-[11px] text-secondary">
          {hasQuery ? (
            <SearchIcon className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ClockIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span className="font-medium">
            {i18nService.t(hasQuery ? 'searchDialogResults' : 'searchDialogRecent')}
          </span>
          <span className="cowork-search-count">{searchResults.length}</span>
          <span className="ml-1 h-px flex-1 bg-border-subtle" aria-hidden="true" />
        </div>
        <div className="cowork-search-body">
          {searchStatus === 'searching' && searchResults.length === 0 && !hasSearchNotice ? (
            <div className="cowork-search-empty" role="status" aria-live="polite">
              <div className="cowork-search-empty-icon" aria-hidden="true">
                <ArrowPathIcon className="h-6 w-6 motion-safe:animate-spin" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {i18nService.t('searchingConversations')}
              </p>
            </div>
          ) : searchResults.length === 0 && hasSearchNotice ? (
            <div className="cowork-search-empty" role="status" aria-live="polite">
              <div className="cowork-search-empty-icon" aria-hidden="true">
                <ExclamationCircleIcon className="h-7 w-7" />
              </div>
              <p className="text-sm text-secondary">{searchNotice}</p>
              <button
                type="button"
                className="cowork-search-retry"
                onClick={() => setSearchRevision(revision => revision + 1)}
              >
                <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {i18nService.t('searchConversationsRetry')}
              </button>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="cowork-search-empty" role="status" aria-live="polite">
              <div className="cowork-search-empty-icon" aria-hidden="true">
                {hasQuery ? (
                  <SearchIcon className="h-7 w-7" />
                ) : (
                  <ChatBubbleLeftRightIcon className="h-7 w-7" />
                )}
              </div>
              <p className="text-sm font-medium text-foreground">
                {i18nService.t(hasQuery ? 'searchNoResults' : 'searchDialogNoConversations')}
              </p>
              <p className="max-w-xs text-xs leading-5 text-secondary">
                {i18nService.t(
                  hasQuery ? 'searchDialogNoResultsHint' : 'searchDialogNoConversationsHint',
                )}
              </p>
            </div>
          ) : (
            <ul
              id="cowork-search-results"
              ref={resultListRef}
              className="space-y-0.5"
              aria-label={i18nService.t('search')}
            >
              {searchResults.map(({ session, messageMatch }, index) => (
                <li key={session.id}>
                  <button
                    id={`cowork-search-result-${index}`}
                    type="button"
                    onClick={() => void handleSelectSession(session.id, messageMatch)}
                    disabled={selecting}
                    aria-current={session.id === currentSessionId ? 'page' : undefined}
                    className="cowork-search-result"
                    data-active={index === activeIndex ? 'true' : undefined}
                  >
                    <span className="cowork-search-result-icon" aria-hidden="true">
                      <ChatBubbleLeftRightIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] text-foreground">
                          <HighlightedText text={session.title} query={searchQuery} />
                        </span>
                        {session.id === currentSessionId && (
                          <span className="cowork-search-current">
                            {i18nService.t('searchDialogCurrent')}
                          </span>
                        )}
                      </div>
                      {messageMatch && (
                        <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-secondary">
                          <HighlightedText text={messageMatch.snippet} query={searchQuery} />
                        </div>
                      )}
                    </div>
                    <time
                      dateTime={new Date(session.updatedAt).toISOString()}
                      className="hidden shrink-0 text-[11px] tabular-nums text-secondary sm:block"
                    >
                      {dateFormatter.format(session.updatedAt)}
                    </time>
                    <ChevronRightIcon className="cowork-search-result-arrow" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hasQuery && currentSearch.truncated && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                className="cowork-search-retry"
                disabled={loadingMore || searchStatus === 'searching' || composing}
                onClick={() => void handleLoadMore()}
              >
                {loadingMore && (
                  <ArrowPathIcon className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />
                )}
                {i18nService.t(loadingMore ? 'searchLoadingMore' : 'searchLoadMore')}
              </button>
            </div>
          )}
          {searchQuery.trim() && searchResults.length > 0 && searchStatus === 'searching' && (
            <div
              className="flex items-center gap-2 px-3 pt-3 text-xs text-secondary"
              role="status"
              aria-live="polite"
            >
              <ArrowPathIcon className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
              {i18nService.t('searchingConversations')}
            </div>
          )}
          {searchResults.length > 0 && hasSearchNotice && (
            <div className="cowork-search-notice" role="status" aria-live="polite">
              <ExclamationCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{searchNotice}</span>
              <button
                type="button"
                className="cowork-search-retry shrink-0"
                onClick={() => setSearchRevision(revision => revision + 1)}
              >
                {i18nService.t('searchConversationsRetry')}
              </button>
            </div>
          )}
          {hasQuery && currentSearch.archivedTranscriptsExcluded > 0 && (
            <p className="px-2 pt-2 text-[11px] leading-4 text-secondary" role="status">
              {i18nService
                .t('searchArchivedExcluded')
                .replace('{count}', String(currentSearch.archivedTranscriptsExcluded))}
            </p>
          )}
        </div>
        <div className="cowork-search-footer">
          <span className="flex items-center gap-1.5">
            <kbd className="cowork-search-key" aria-hidden="true">
              ↑
            </kbd>
            <kbd className="cowork-search-key" aria-hidden="true">
              ↓
            </kbd>
            <span className="ml-1">{i18nService.t('searchDialogNavigate')}</span>
          </span>
          <span className="flex items-center gap-2">
            <kbd className="cowork-search-key" aria-hidden="true">
              <ArrowTurnDownLeftIcon className="h-3 w-3" />
            </kbd>
            {i18nService.t('searchDialogOpen')}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <kbd className="cowork-search-key" aria-hidden="true">
              Esc
            </kbd>
            {i18nService.t('close')}
          </span>
        </div>
      </div>
    </Modal>
  );
};

export default CoworkSearchModal;
