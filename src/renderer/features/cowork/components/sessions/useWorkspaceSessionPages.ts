import { SESSION_LIST_PAGE_SIZE, type SessionDirectoryEntry } from '@shared/cowork/sessionDirectory';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import type { SessionWorkspaceGroup } from '@/features/cowork/sessionPresentation';

import type { SessionListPageFooterProps } from './SessionListPageFooter';

interface WorkspacePageState {
  consumedIds: ReadonlySet<string>;
  request?: {
    ids: string[];
    failed: boolean;
  };
}

const emptyPage: WorkspacePageState = { consumedIds: new Set() };

export function useWorkspaceSessionPages(
  expandedGroups: SessionWorkspaceGroup[],
  visibleIds: Pick<ReadonlySet<string>, 'has'>,
  summaryIds: Pick<ReadonlySet<string>, 'has'>,
) {
  const [pages, setPages] = useState<ReadonlyMap<string, WorkspacePageState>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const currentVisibility = useRef(visibleIds);
  const previousVisibility = useRef(visibleIds);
  useLayoutEffect(() => {
    currentVisibility.current = visibleIds;
  }, [visibleIds]);

  const requestPage = useCallback((key: string, ids: string[]) => {
    if (ids.length === 0 || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPages(current => new Map(current).set(key, {
      consumedIds: current.get(key)?.consumedIds ?? emptyPage.consumedIds,
      request: { ids, failed: false },
    }));
    const finish = (success: boolean) => {
      inFlight.current.delete(key);
      setPages(current => {
        const consumed = current.get(key)?.consumedIds ?? emptyPage.consumedIds;
        return new Map(current).set(key, success
          ? { consumedIds: new Set([...consumed, ...ids]) }
          : { consumedIds: consumed, request: { ids, failed: true } });
      });
    };
    // A page keeps its raw membership through the read, including hidden rows.
    void coworkService.readSessionSummaryPage(ids, id => currentVisibility.current.has(id))
      .then(finish, () => finish(false));
  }, []);

  useEffect(() => {
    for (const group of expandedGroups) {
      const page = pages.get(group.key);
      if (!page?.request && !group.sessions.some(entry => page?.consumedIds.has(entry.id))) {
        requestPage(group.key, group.sessions.slice(0, SESSION_LIST_PAGE_SIZE).map(entry => entry.id));
      }
    }
  }, [expandedGroups, pages, requestPage]);

  const liveHeadIds: string[] = [];
  for (const group of expandedGroups) {
    const page = pages.get(group.key);
    if (!page?.consumedIds.size || page.request) continue;
    for (const { id } of group.sessions.slice(0, SESSION_LIST_PAGE_SIZE)) {
      if (!page.consumedIds.has(id) && visibleIds.has(id) && !summaryIds.has(id)) {
        liveHeadIds.push(id);
      }
    }
  }
  const liveHeadRequest = JSON.stringify(liveHeadIds);
  useEffect(() => {
    if (liveHeadRequest !== '[]') {
      void coworkService.ensureSessionSummaries(JSON.parse(liveHeadRequest) as string[]);
    }
  }, [liveHeadRequest]);

  useEffect(() => {
    const previous = previousVisibility.current;
    previousVisibility.current = visibleIds;
    if (previous === visibleIds) return;
    const revealed = new Set<string>();
    for (const page of pages.values()) {
      for (const id of page.consumedIds) {
        if (!previous.has(id) && visibleIds.has(id) && !summaryIds.has(id)) revealed.add(id);
      }
    }
    if (revealed.size) void coworkService.ensureSessionSummaries([...revealed]);
  }, [pages, summaryIds, visibleIds]);

  return (group: SessionWorkspaceGroup): {
    entries: SessionDirectoryEntry[];
    footer: SessionListPageFooterProps;
  } => {
    const page = pages.get(group.key) ?? emptyPage;
    const entries: SessionDirectoryEntry[] = [];
    const nextIds: string[] = [];
    const hasLoadedPage = page.consumedIds.size > 0;
    for (const [index, entry] of group.sessions.entries()) {
      // Newly created or moved rows can already have summaries. Surface them
      // in the leading raw page without reading an extra page in the background.
      const alreadyVisible = hasLoadedPage && index < SESSION_LIST_PAGE_SIZE &&
        visibleIds.has(entry.id) && summaryIds.has(entry.id) && !page.request?.ids.includes(entry.id);
      if (page.consumedIds.has(entry.id) || alreadyVisible) entries.push(entry);
      else if (nextIds.length < SESSION_LIST_PAGE_SIZE) {
        nextIds.push(entry.id);
      }
    }
    const failed = page.request?.failed ?? false;
    return {
      entries,
      footer: {
        isLoading: !pages.has(group.key) || Boolean(page.request && !failed),
        loadFailed: failed,
        hasMore: nextIds.length > 0,
        onShowMore: () => requestPage(group.key, nextIds),
        onRetry: () => requestPage(group.key, page.request?.ids ?? []),
      },
    };
  };
}
