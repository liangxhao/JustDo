import {
  ArrowPathIcon,
  ChevronRightIcon,
  FolderIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import type { WorkspaceDirectoryEntry } from '@shared/preview/filePreview';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import WorkspaceFileIcon from './WorkspaceFileIcon';

interface WorkspaceFilesPanelProps {
  activeFilePath?: string;
  isVisible?: boolean;
  revealPath?: string;
  revealVersion?: number;
  onOpenFile: (filePath: string) => void;
  sessionId: string;
}

const WorkspaceFilesPanel = ({
  activeFilePath,
  isVisible = true,
  revealPath,
  revealVersion,
  onOpenFile,
  sessionId,
}: WorkspaceFilesPanelProps) => {
  const [entriesByDirectory, setEntriesByDirectory] = useState<
    Record<string, WorkspaceDirectoryEntry[]>
  >({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [failedDirectories, setFailedDirectories] = useState<Set<string>>(new Set());
  const [truncatedDirectories, setTruncatedDirectories] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const activeSessionIdRef = useRef(sessionId);
  const directoryRequestsRef = useRef(new Map<string, symbol>());
  const filterInputRef = useRef<HTMLInputElement>(null);
  const treeItemRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingRevealPath = useRef<string | null>(null);
  activeSessionIdRef.current = sessionId;

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      const requestedSessionId = sessionId;
      const request = Symbol();
      directoryRequestsRef.current.set(relativePath, request);
      const isCurrentRequest = () =>
        activeSessionIdRef.current === requestedSessionId &&
        directoryRequestsRef.current.get(relativePath) === request;
      const markFailed = () => {
        setFailedDirectories(current => new Set(current).add(relativePath));
        setEntriesByDirectory(current => {
          const next = { ...current };
          delete next[relativePath];
          return next;
        });
      };
      setLoadingDirectories(current => new Set(current).add(relativePath));
      setFailedDirectories(current => {
        const next = new Set(current);
        next.delete(relativePath);
        return next;
      });
      try {
        const result = await window.electron.shell.listWorkspaceDirectory(
          requestedSessionId,
          relativePath,
        );
        if (!isCurrentRequest()) return;
        if (!result.success) {
          markFailed();
          return;
        }
        setEntriesByDirectory(current => ({ ...current, [relativePath]: result.entries }));
        setTruncatedDirectories(current => {
          const next = new Set(current);
          if (result.truncated) next.add(relativePath);
          else next.delete(relativePath);
          return next;
        });
      } catch {
        if (!isCurrentRequest()) return;
        markFailed();
      } finally {
        if (isCurrentRequest()) {
          setLoadingDirectories(current => {
            const next = new Set(current);
            next.delete(relativePath);
            return next;
          });
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    const directoryRequests = directoryRequestsRef.current;
    directoryRequests.clear();
    setEntriesByDirectory({});
    setExpandedDirectories(new Set());
    setLoadingDirectories(new Set());
    setFailedDirectories(new Set());
    setTruncatedDirectories(new Set());
    setQuery('');
    setFocusedPath(null);
    void loadDirectory('');
    return () => directoryRequests.clear();
  }, [loadDirectory, sessionId]);

  useEffect(() => {
    if (isVisible) filterInputRef.current?.focus();
  }, [isVisible]);

  useEffect(() => {
    pendingRevealPath.current = null;
    if (!revealPath) return;
    const parts = revealPath.split('/');
    if (parts.some(part => part === '..' || !part)) return;
    pendingRevealPath.current = revealPath;
    setQuery('');
    const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    setExpandedDirectories(new Set(parents));
    setFocusedPath(revealPath);
    for (const parent of parents) void loadDirectory(parent);
  }, [revealPath, revealVersion, loadDirectory]);
  useEffect(() => {
    if (!isVisible || !pendingRevealPath.current) return;
    const node = treeItemRefs.current.get(pendingRevealPath.current);
    if (!node) return;
    pendingRevealPath.current = null;
    node.scrollIntoView?.({ block: 'nearest' });
    node.focus();
  }, [isVisible, revealPath, revealVersion, entriesByDirectory, query, expandedDirectories]);

  const refreshDirectories = () => {
    const directories = new Set(['', ...Object.keys(entriesByDirectory), ...expandedDirectories]);
    for (const directory of directories) void loadDirectory(directory);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      const isExpanded = expandedDirectories.has(relativePath);
      setExpandedDirectories(current => {
        const next = new Set(current);
        if (isExpanded) next.delete(relativePath);
        else next.add(relativePath);
        return next;
      });
      if (!isExpanded && !entriesByDirectory[relativePath]) void loadDirectory(relativePath);
    },
    [entriesByDirectory, expandedDirectories, loadDirectory],
  );

  const visibleTree = useMemo(() => {
    const collectDirectory = (
      relativePath: string,
      depth: number,
    ): Array<{ depth: number; entry: WorkspaceDirectoryEntry }> => {
      const rows: Array<{ depth: number; entry: WorkspaceDirectoryEntry }> = [];
      for (const entry of entriesByDirectory[relativePath] ?? []) {
        const childRows =
          entry.kind === 'directory' &&
          (expandedDirectories.has(entry.relativePath) ||
            (Boolean(normalizedQuery) && Boolean(entriesByDirectory[entry.relativePath])))
            ? collectDirectory(entry.relativePath, depth + 1)
            : [];
        const matchesSelf =
          !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery);
        if (matchesSelf || childRows.length > 0) {
          rows.push({ depth, entry });
          rows.push(...childRows);
        }
      }
      return rows;
    };
    return collectDirectory('', 0);
  }, [entriesByDirectory, expandedDirectories, normalizedQuery]);

  const focusTreeItem = useCallback(
    (index: number) => {
      const row = visibleTree[index];
      if (!row) return;
      setFocusedPath(row.entry.relativePath);
      treeItemRefs.current.get(row.entry.relativePath)?.focus();
    },
    [visibleTree],
  );
  const focusedPathIsVisible = visibleTree.some(row => row.entry.relativePath === focusedPath);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={i18nService.t('coworkWorkspaceFiles')}
    >
      <div
        className="flex h-10 shrink-0 items-center gap-1 px-2"
        role="toolbar"
        aria-label={i18nService.t('coworkWorkspaceFilesTools')}
      >
        <span className="mr-auto min-w-0 truncate text-xs font-medium text-secondary">
          {i18nService.t('coworkWorkspaceFiles')}
        </span>
        <button
          type="button"
          onClick={refreshDirectories}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          title={i18nService.t('coworkWorkspaceFilesRefresh')}
          aria-label={i18nService.t('coworkWorkspaceFilesRefresh')}
          aria-busy={loadingDirectories.size > 0}
        >
          <ArrowPathIcon
            className={`h-4 w-4 ${loadingDirectories.size > 0 ? 'animate-spin motion-reduce:animate-none' : ''}`}
          />
        </button>
        <button
          type="button"
          onClick={() => {
            pendingRevealPath.current = null;
            setExpandedDirectories(new Set());
            setQuery('');
            setFocusedPath(null);
          }}
          disabled={expandedDirectories.size === 0 && query.length === 0}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          title={i18nService.t('coworkWorkspaceFilesCollapseAll')}
          aria-label={i18nService.t('coworkWorkspaceFilesCollapseAll')}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 13V4h9M9 9h11v11H9zM12 14.5h5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="shrink-0 border-b border-border px-2 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 text-secondary focus-within:border-primary/60">
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0" />
          <input
            ref={filterInputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'ArrowDown' || visibleTree.length === 0) return;
              event.preventDefault();
              focusTreeItem(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
            placeholder={i18nService.t('coworkWorkspaceFilesFilter')}
            aria-label={i18nService.t('coworkWorkspaceFilesFilter')}
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1" role="tree">
        {loadingDirectories.has('') && !entriesByDirectory[''] ? (
          <div className="px-4 py-3 text-sm text-muted" role="status">
            {i18nService.t('loading')}
          </div>
        ) : failedDirectories.has('') ? (
          <div className="px-4 py-3 text-sm text-destructive" role="alert">
            {i18nService.t('coworkWorkspaceFilesLoadFailed')}
          </div>
        ) : visibleTree.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted">
            {i18nService.t(
              normalizedQuery ? 'coworkWorkspaceFilesNoMatches' : 'coworkWorkspaceFilesEmpty',
            )}
          </div>
        ) : (
          visibleTree.map(({ depth, entry }, index) => {
            const isDirectory = entry.kind === 'directory';
            const isExpanded = isDirectory && expandedDirectories.has(entry.relativePath);
            const isLoading = isDirectory && loadingDirectories.has(entry.relativePath);
            return (
              <div key={entry.relativePath} role="none">
                <button
                  ref={element => {
                    if (element) treeItemRefs.current.set(entry.relativePath, element);
                    else treeItemRefs.current.delete(entry.relativePath);
                  }}
                  type="button"
                  role="treeitem"
                  aria-expanded={isDirectory ? isExpanded : undefined}
                  aria-level={depth + 1}
                  aria-selected={!isDirectory && activeFilePath === entry.filePath}
                  tabIndex={
                    focusedPath === entry.relativePath || (!focusedPathIsVisible && index === 0)
                      ? 0
                      : -1
                  }
                  onFocus={() => setFocusedPath(entry.relativePath)}
                  onClick={() =>
                    isDirectory ? toggleDirectory(entry.relativePath) : onOpenFile(entry.filePath)
                  }
                  onKeyDown={event => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      focusTreeItem(Math.min(index + 1, visibleTree.length - 1));
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      focusTreeItem(Math.max(index - 1, 0));
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      focusTreeItem(0);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      focusTreeItem(visibleTree.length - 1);
                    } else if (event.key === 'ArrowRight' && isDirectory && !isExpanded) {
                      event.preventDefault();
                      toggleDirectory(entry.relativePath);
                    } else if (event.key === 'ArrowRight' && isDirectory && isExpanded) {
                      event.preventDefault();
                      if (visibleTree[index + 1]?.depth === depth + 1) focusTreeItem(index + 1);
                    } else if (event.key === 'ArrowLeft' && isDirectory && isExpanded) {
                      event.preventDefault();
                      toggleDirectory(entry.relativePath);
                    } else if (event.key === 'ArrowLeft' && depth > 0) {
                      event.preventDefault();
                      for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
                        if (visibleTree[parentIndex]?.depth === depth - 1) {
                          focusTreeItem(parentIndex);
                          break;
                        }
                      }
                    }
                  }}
                  className={`flex h-7 w-full items-center gap-1.5 pr-3 text-left text-sm text-foreground hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none ${
                    !isDirectory && activeFilePath === entry.filePath ? 'bg-surface-raised' : ''
                  }`}
                  style={{ paddingLeft: `${8 + depth * 16}px` }}
                  title={entry.filePath}
                >
                  {isDirectory ? (
                    <ChevronRightIcon
                      className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    />
                  ) : (
                    <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {isDirectory ? (
                    <FolderIcon className="h-4 w-4 shrink-0 text-secondary" />
                  ) : (
                    <WorkspaceFileIcon fileName={entry.name} />
                  )}
                  <span className="truncate">{entry.name}</span>
                  {isLoading && (
                    <span className="ml-auto text-xs text-muted">{i18nService.t('loading')}</span>
                  )}
                </button>
                {isExpanded && failedDirectories.has(entry.relativePath) && (
                  <div
                    className="py-1 pr-3 text-xs text-destructive"
                    style={{ paddingLeft: `${40 + depth * 16}px` }}
                  >
                    {i18nService.t('coworkWorkspaceFilesLoadFailed')}
                  </div>
                )}
                {isExpanded && truncatedDirectories.has(entry.relativePath) && (
                  <div
                    className="py-1 pr-3 text-xs text-muted"
                    style={{ paddingLeft: `${40 + depth * 16}px` }}
                  >
                    {i18nService.t('coworkWorkspaceFilesTruncated')}
                  </div>
                )}
              </div>
            );
          })
        )}
        {truncatedDirectories.has('') && (
          <div className="px-4 py-2 text-xs text-muted">
            {i18nService.t('coworkWorkspaceFilesTruncated')}
          </div>
        )}
      </div>
    </section>
  );
};

export default WorkspaceFilesPanel;
