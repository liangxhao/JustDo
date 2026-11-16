import {
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  ShareIcon,
} from '@heroicons/react/24/outline';
import type { WorktreeInitialCommitOffer } from '@shared/cowork/worktreeInitialCommit';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { isDomHTMLElement, useOwnerDocument } from '@/shared/dom/ownerDocument';

import {
  buildCommitTree,
  countCommitFilesByFolder,
  flattenCommitTree,
  selectCommitTreeEntry,
} from './worktreeCommitTree';

interface InitialWorktreeCommitDialogProps {
  offer: WorktreeInitialCommitOffer;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (paths: string[]) => void;
}

function togglePath(paths: Set<string>, path: string): Set<string> {
  const next = new Set(paths);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export function InitialWorktreeCommitDialog({
  offer,
  busy,
  error,
  onCancel,
  onConfirm,
}: InitialWorktreeCommitDialogProps) {
  const ownerDocument = useOwnerDocument();
  const titleId = useId();
  const descriptionId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState(new Set<string>());
  const [collapsedSearchPaths, setCollapsedSearchPaths] = useState(new Set<string>());
  const [selectedPaths, setSelectedPaths] = useState(
    () => new Set(offer.files.filter(file => file.staged).map(file => file.path)),
  );

  const tree = useMemo(() => buildCommitTree(offer.files), [offer.files]);
  const search = useMemo(() => {
    const searchTerm = query.trim().toLowerCase();
    if (!searchTerm) return null;
    const files = new Set(
      offer.files
        .filter(file => file.path.toLowerCase().includes(searchTerm))
        .map(file => file.path),
    );
    return { files, folders: countCommitFilesByFolder(files) };
  }, [offer.files, query]);
  const rows = useMemo(
    () =>
      flattenCommitTree(
        tree,
        expandedPaths,
        search && { ...search, collapsed: collapsedSearchPaths },
      ),
    [tree, expandedPaths, search, collapsedSearchPaths],
  );
  const selectedFiles = useMemo(() => [...selectedPaths].sort(), [selectedPaths]);
  const selectedCounts = useMemo(
    () =>
      countCommitFilesByFolder(
        search ? selectedFiles.filter(path => search.files.has(path)) : selectedFiles,
      ),
    [search, selectedFiles],
  );

  useEffect(() => {
    const previous = ownerDocument.activeElement;
    searchInput.current?.focus();
    return () => {
      if (isDomHTMLElement(previous) && previous.isConnected) previous.focus();
    };
  }, [ownerDocument]);

  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);

  function handleDialogKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled)',
    );
    const first = controls?.[0];
    const last = controls?.[controls.length - 1];
    const current = ownerDocument.activeElement;
    if (!first || current === dialog.current || current === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  return createPortal(
    <Modal
      onClose={onCancel}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-3 sm:p-6"
      className="w-full max-w-[54rem] overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl"
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKey}
        className="flex max-h-[calc(100dvh-1.5rem)] min-h-0 flex-col outline-none sm:max-h-[calc(100dvh-3rem)]"
      >
        <header className="shrink-0 px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start gap-3.5">
            <div className="rounded-xl bg-primary/10 p-3 text-primary">
              <ShareIcon className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold tracking-tight">
                {i18nService.t('worktreeInitialCommitTitle')}
              </h2>
              <p id={descriptionId} className="mt-1 text-sm text-secondary">
                {i18nService.t('worktreeInitialCommitDescription')}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-secondary">
            <FolderIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono text-xs" dir="auto" title={offer.projectRoot}>
              {offer.projectRoot}
            </span>
          </div>
        </header>

        <div className="mx-4 mb-4 flex h-[22rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border sm:mx-6 sm:mb-5 sm:grid sm:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <label className="m-3 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 text-secondary focus-within:border-primary">
              <MagnifyingGlassIcon className="size-4 shrink-0" aria-hidden="true" />
              <input
                ref={searchInput}
                type="search"
                aria-label={i18nService.t('worktreeInitialCommitSearch')}
                placeholder={i18nService.t('worktreeInitialCommitSearch')}
                disabled={busy}
                value={query}
                onChange={event => {
                  setQuery(event.currentTarget.value);
                  setCollapsedSearchPaths(new Set());
                }}
                className="w-full min-w-0 bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-secondary"
              />
            </label>
            <ul
              aria-label={i18nService.t('worktreeInitialCommitFiles')}
              className="min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-2"
            >
              {rows.length === 0 && (
                <li className="px-2 py-4 text-sm text-secondary">
                  {i18nService.t(
                    search ? 'worktreeInitialCommitNoMatches' : 'worktreeInitialCommitNoFiles',
                  )}
                </li>
              )}
              {rows.map(({ entry, depth, expanded }) => {
                const isFolder = entry.kind === 'folder';
                const count = isFolder ? (search?.folders.get(entry.path) ?? entry.fileCount) : 1;
                const selectedCount = isFolder
                  ? (selectedCounts.get(entry.path) ?? 0)
                  : Number(selectedPaths.has(entry.path));
                const mixed = selectedCount > 0 && selectedCount < count;
                const Icon = isFolder ? (expanded ? FolderOpenIcon : FolderIcon) : DocumentIcon;
                return (
                  <li
                    key={`${entry.kind}:${entry.path}`}
                    className="relative flex h-8 min-w-0 items-center gap-1 rounded-md pr-2 hover:bg-surface-raised"
                    style={{ paddingInlineStart: `${0.25 + depth * 1.25}rem` }}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-3 flex"
                    >
                      {Array.from({ length: depth }, (_, level) => (
                        <span key={level} className="w-5 border-l border-border/70" />
                      ))}
                    </span>
                    {isFolder ? (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={i18nService
                          .t(
                            expanded
                              ? 'worktreeInitialCommitCollapseFolder'
                              : 'worktreeInitialCommitExpandFolder',
                          )
                          .replace('{folder}', () => entry.path)}
                        disabled={busy}
                        onClick={() => {
                          const update = search ? setCollapsedSearchPaths : setExpandedPaths;
                          update(paths => togglePath(paths, entry.path));
                        }}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-secondary hover:bg-border focus-visible:outline-primary"
                      >
                        {expanded ? (
                          <ChevronDownIcon className="size-3.5" />
                        ) : (
                          <ChevronRightIcon className="size-3.5" />
                        )}
                      </button>
                    ) : (
                      <span className="w-6 shrink-0" aria-hidden="true" />
                    )}
                    <label
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm"
                      title={entry.path}
                    >
                      <input
                        type="checkbox"
                        aria-label={entry.path}
                        disabled={busy}
                        checked={selectedCount === count}
                        ref={node => {
                          if (node) node.indeterminate = mixed;
                        }}
                        onChange={event => {
                          const checked = event.currentTarget.checked;
                          setSelectedPaths(paths =>
                            selectCommitTreeEntry(paths, entry, checked, search?.files),
                          );
                        }}
                        className="size-4 shrink-0 accent-primary"
                      />
                      <Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
                      <span className="truncate" dir="auto">
                        {entry.name}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          <aside className="flex max-h-[34%] min-h-0 min-w-0 flex-col border-t border-border bg-surface-raised/60 sm:max-h-none sm:border-l sm:border-t-0">
            <h3 className="shrink-0 px-4 py-3 text-sm font-semibold" aria-live="polite">
              {i18nService
                .t('worktreeInitialCommitSelectedCount')
                .replace('{count}', String(selectedFiles.length))}
            </h3>
            <ul className="min-h-0 flex-1 space-y-2.5 overflow-auto overscroll-contain px-4 pb-4">
              {selectedFiles.length === 0 ? (
                <li className="text-sm text-secondary">
                  {i18nService.t('worktreeInitialCommitEmptySelection')}
                </li>
              ) : (
                selectedFiles.map(path => {
                  const separator = path.lastIndexOf('/');
                  return (
                    <li key={path} className="flex items-start gap-2.5" title={path}>
                      <DocumentIcon
                        className="mt-0.5 size-4 shrink-0 text-secondary"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm" dir="auto">
                          {path.slice(separator + 1)}
                        </div>
                        {separator >= 0 && (
                          <div className="truncate text-xs text-secondary" dir="auto">
                            {path.slice(0, separator + 1)}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </aside>
        </div>

        <footer className="shrink-0 border-t border-border px-4 py-3 sm:px-6 sm:py-4">
          {error && (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="text-xs leading-relaxed text-secondary">
              {i18nService.t('worktreeInitialCommitLocalOnly')}
              <br />
              {i18nService.t('worktreeInitialCommitSendAfterCheckout')}
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-raised disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onConfirm(selectedFiles)}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {i18nService.t(
                  busy ? 'worktreeInitialCommitCreating' : 'worktreeInitialCommitConfirm',
                )}
              </button>
            </div>
          </div>
        </footer>
      </section>
    </Modal>,
    ownerDocument.body,
  );
}
