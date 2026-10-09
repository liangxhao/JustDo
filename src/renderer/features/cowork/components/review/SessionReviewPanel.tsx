import './sessionReview.css';

import {
  ArrowPathIcon,
  Bars3BottomLeftIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  ViewColumnsIcon,
} from '@heroicons/react/24/outline';
import {
  ReviewScope,
  type SessionReviewDiff,
  type SessionReviewFileAction,
  type SessionReviewQuery,
  type SessionReviewResult,
} from '@shared/cowork/sessionReview';
import { useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import WorkspaceFileIcon from '../shared/WorkspaceFileIcon';
import SessionReviewPatch from './SessionReviewPatch';

interface Props {
  sessionId: string;
  visible: boolean;
  running?: boolean;
  focusPath?: string;
  focusVersion?: number;
  onOpenFile: (path: string, relative: string, reveal: boolean) => void;
}
export default function SessionReviewPanel({
  sessionId,
  visible,
  running,
  focusPath,
  focusVersion,
  onOpenFile,
}: Props) {
  const [scope, setScope] = useState<SessionReviewQuery['scope']>(ReviewScope.All);
  const [commit, setCommit] = useState('');
  const [commitInput, setCommitInput] = useState('');
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; diff: SessionReviewDiff }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [fileLimit, setFileLimit] = useState(100);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [explanationOpen, setExplanationOpen] = useState(false);
  const explanationId = useId();
  const [updated, setUpdated] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyGeneration = useRef(0);
  useEffect(() => {
    copyGeneration.current++;
    setCopied('');
    setCopyError(false);
    return () => clearTimeout(copyTimer.current);
  }, [sessionId, scope, commit, visible]);
  const fileNodes = useRef(new Map<string, HTMLElement>());
  const [selectedFile, setSelectedFile] = useState('');
  const generation = useRef(0);
  const loadedRequest = useRef('');
  const loadFlight = useRef<{ key: string; promise: Promise<SessionReviewResult> }>();
  const focusNode = useRef<HTMLElement | null>(null);
  const lastFocusRequest = useRef('');
  const lastScrolledFocusRequest = useRef('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const actionFlight = useRef(false);
  const actionGeneration = useRef(0);
  const wasRunning = useRef(running);
  const key = JSON.stringify([sessionId, scope, commit]);
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => {
    actionGeneration.current++;
  }, [key, visible]);
  const query: SessionReviewQuery = {
    sessionId,
    scope,
    ...(scope === ReviewScope.Commit ? { commit } : {}),
  };
  const diff = snapshot?.key === key ? snapshot.diff : undefined;
  const normalizedFocus = focusPath?.replace(/\\/g, '/');
  // Prefer an exact path, then the longest suffix. An absolute src/file.ts
  // target must not also expand file.ts at the checkout root.
  const focusedPath = diff?.files.reduce<string | undefined>((selected, file) => {
    if (!normalizedFocus || selected === normalizedFocus) return selected;
    if (file.path === normalizedFocus) return file.path;
    if (normalizedFocus.endsWith(`/${file.path}`) && file.path.length > (selected?.length ?? 0))
      return file.path;
    return selected;
  }, undefined);
  const focusRequest = JSON.stringify([sessionId, focusPath, focusVersion]);
  useEffect(() => {
    if (!visible || !focusedPath || lastScrolledFocusRequest.current === focusRequest) return;
    if (focusNode.current) {
      focusNode.current.scrollIntoView?.({ block: 'nearest' });
      lastScrolledFocusRequest.current = focusRequest;
    }
  }, [focusedPath, focusRequest, visible, fileLimit, filter]);
  useEffect(() => {
    if (wasRunning.current && !running) setUpdated(true);
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    if (!focusPath || lastFocusRequest.current === focusRequest) return;
    setFilter('');
    const index = diff?.files.findIndex(file => file.path === focusedPath) ?? -1;
    if (index >= 0 && diff) {
      lastFocusRequest.current = focusRequest;
      const path = diff.files[index].path;
      setFileLimit(limit => Math.max(limit, index + 1));
      setExpanded(current => {
        const next = new Set(current);
        next.add(path);
        next.delete(`closed:${path}`);
        return next;
      });
    }
  }, [focusPath, focusRequest, focusedPath, diff]);
  useEffect(() => {
    if (!visible) return;
    const review = window.electron?.cowork?.review;
    if (typeof review?.load !== 'function' || typeof review?.file !== 'function') {
      setLoading(false);
      setError('bridge');
      return;
    }
    if (scope === ReviewScope.Commit && !commit) {
      setLoading(false);
      setError('');
      return;
    }
    const requestKey = JSON.stringify([key, revision]);
    // A retained tab is a review snapshot. Switching tabs must not rescan the
    // checkout or discard an in-flight read; explicit refresh still does both.
    if (loadedRequest.current === requestKey) {
      setLoading(false);
      return;
    }
    const request = ++generation.current;
    let cancelled = false;
    setLoading(true);
    setError('');
    setActionError(false);
    if (loadFlight.current?.key !== requestKey) {
      const flight = {
        key: requestKey,
        promise: (async () =>
          review.load({ sessionId, scope, ...(scope === ReviewScope.Commit ? { commit } : {}) }))(),
      };
      loadFlight.current = flight;
      const release = () => {
        if (loadFlight.current === flight) loadFlight.current = undefined;
      };
      void flight.promise.then(release, release);
    }
    void loadFlight.current.promise
      .then(result => {
        if (cancelled || generation.current !== request || activeKey.current !== key) return;
        if (result.success) {
          loadedRequest.current = requestKey;
          setSnapshot({ key, diff: result.diff });
          setUpdated(false);
        } else setError(result.reason);
      })
      .catch(() => {
        if (!cancelled && activeKey.current === key) setError('unavailable');
      })
      .finally(() => {
        if (!cancelled && activeKey.current === key) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, scope, commit, revision, visible, key]);
  async function openFile(relative: string, action: SessionReviewFileAction) {
    if (actionFlight.current) return;
    const request = actionGeneration.current;
    actionFlight.current = true;
    setActionPending(true);
    setActionError(false);
    try {
      const result = await window.electron.cowork.review.file(query, relative, action);
      if (!mounted.current || activeKey.current !== key || actionGeneration.current !== request)
        return;
      if (!result.success) setActionError(true);
      else if (action !== 'editor')
        onOpenFile(result.filePath, result.relativePath, action === 'files');
    } catch {
      if (mounted.current && activeKey.current === key && actionGeneration.current === request)
        setActionError(true);
    } finally {
      actionFlight.current = false;
      setActionPending(false);
    }
  }
  async function openFolder() {
    if (!diff?.root || actionFlight.current) return;
    const request = actionGeneration.current;
    actionFlight.current = true;
    setActionPending(true);
    setActionError(false);
    try {
      const result = await window.electron.shell.openPath(diff.root);
      if (mounted.current && activeKey.current === key && actionGeneration.current === request)
        setActionError(!result.success);
    } catch {
      if (mounted.current && activeKey.current === key && actionGeneration.current === request)
        setActionError(true);
    } finally {
      actionFlight.current = false;
      if (mounted.current) setActionPending(false);
    }
  }
  async function copy(value: string, target: string) {
    const request = ++copyGeneration.current;
    clearTimeout(copyTimer.current);
    setCopied('');
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current || request !== copyGeneration.current) return;
      setCopied(target);
      copyTimer.current = setTimeout(() => setCopied(''), 2000);
    } catch {
      if (mounted.current && request === copyGeneration.current) setCopyError(true);
    }
  }
  const files =
    diff?.files.filter(file =>
      `${file.oldPath ?? ''} ${file.path}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  return (
    <section className="session-review" hidden={!visible} aria-label={i18nService.t('reviewTitle')}>
      <header className="review-toolbar">
        <div className="review-toolbar-row">
          <div className="review-scope">
            <label>
              <span className="review-scope-label">{i18nService.t('reviewScope')}</span>
              <span className="review-select-wrap">
                <select
                  aria-label={i18nService.t('reviewScope')}
                  value={scope}
                  onChange={event => {
                    setScope(event.target.value as SessionReviewQuery['scope']);
                    setError('');
                  }}
                >
                  <option value={ReviewScope.All}>{i18nService.t('reviewAll')}</option>
                  <option value={ReviewScope.Uncommitted}>
                    {i18nService.t('reviewUncommitted')}
                  </option>
                  <option value={ReviewScope.Commit}>{i18nService.t('reviewCommit')}</option>
                </select>
                <ChevronDownIcon aria-hidden="true" />
              </span>
            </label>
          </div>
          {diff && (
            <div className="review-stats">
              <span>
                <strong>{diff.files.length}</strong> {i18nService.t('reviewFiles')}
              </span>
              <span className="review-added">+{diff.additions}</span>
              <span className="review-deleted">−{diff.deletions}</span>
            </div>
          )}
          <div className="review-controls review-toolbar-actions">
            {diff?.root && (
              <button
                type="button"
                className="review-button"
                title={i18nService.t('reviewOpenFolder')}
                aria-label={i18nService.t('reviewOpenFolder')}
                disabled={actionPending}
                onClick={() => void openFolder()}
              >
                <FolderOpenIcon aria-hidden="true" />
              </button>
            )}
            <button
              className="review-button"
              disabled={loading}
              aria-label={i18nService.t(loading ? 'reviewLoading' : 'reviewRefresh')}
              title={i18nService.t('reviewRefresh')}
              onClick={() => setRevision(value => value + 1)}
            >
              <ArrowPathIcon aria-hidden="true" className={loading ? 'review-spinning' : ''} />
              <span className="review-refresh-label">
                {i18nService.t(loading ? 'reviewLoading' : 'reviewRefresh')}
              </span>
            </button>
            <div
              className="review-view-toggle"
              role="group"
              aria-label={i18nService.t('reviewLayout')}
            >
              <button
                className="review-button"
                aria-pressed={!split}
                title={i18nService.t('reviewUnified')}
                aria-label={i18nService.t('reviewUnified')}
                onClick={() => setSplit(false)}
              >
                <Bars3BottomLeftIcon aria-hidden="true" />
              </button>
              <button
                className="review-button"
                aria-pressed={split}
                title={i18nService.t('reviewSplit')}
                aria-label={i18nService.t('reviewSplit')}
                onClick={() => setSplit(true)}
              >
                <ViewColumnsIcon aria-hidden="true" />
              </button>
            </div>
            <details
              className="review-more"
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }
              }}
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  event.currentTarget.open = false;
              }}
            >
              <summary
                title={i18nService.t('reviewMoreOptions')}
                aria-label={i18nService.t('reviewMoreOptions')}
              >
                <EllipsisHorizontalIcon aria-hidden="true" />
              </summary>
              <div className="review-more-popover">
                <label className="review-wrap-toggle">
                  <input
                    type="checkbox"
                    checked={wrap}
                    onChange={event => setWrap(event.target.checked)}
                  />
                  {i18nService.t('reviewWrap')}
                </label>
              </div>
            </details>
          </div>
          <button
            type="button"
            className={`review-explanation-toggle${diff?.truncated ? ' has-warning' : ''}`}
            title={i18nService.t('reviewAbout')}
            aria-label={i18nService.t('reviewAbout')}
            aria-expanded={explanationOpen}
            aria-controls={explanationId}
            onClick={() => setExplanationOpen(value => !value)}
          >
            <InformationCircleIcon aria-hidden="true" />
          </button>
        </div>
        <div id={explanationId} className="review-explanation" hidden={!explanationOpen}>
          <div className="review-explanation-note">
            <InformationCircleIcon aria-hidden="true" />
            <div>
              <strong>{i18nService.t('reviewAbout')}</strong>
              <p>{i18nService.t('reviewOwnership')}</p>
            </div>
          </div>
          {diff?.truncated && (
            <div className="review-explanation-note review-explanation-warning">
              <ExclamationTriangleIcon aria-hidden="true" />
              <p>{i18nService.t('reviewTruncated')}</p>
            </div>
          )}
          {diff?.branch && (
            <p className="review-explanation-branch">
              {i18nService.t('reviewBranch')}: <strong>{diff.branch}</strong>
            </p>
          )}
        </div>
        <div className="review-commit-controls">
          {scope === ReviewScope.Commit && (
            <form
              className="review-controls"
              onSubmit={event => {
                event.preventDefault();
                setCommit(commitInput.trim());
                setRevision(value => value + 1);
              }}
            >
              <input
                aria-label={i18nService.t('reviewCommit')}
                value={commitInput}
                onChange={event => setCommitInput(event.target.value)}
                list={`review-commits-${sessionId}`}
                placeholder={i18nService.t('reviewCommitPlaceholder')}
              />
              <datalist id={`review-commits-${sessionId}`}>
                {snapshot?.diff.commits?.map(item => (
                  <option key={item.sha} value={item.sha}>
                    {item.subject}
                  </option>
                ))}
              </datalist>
              <button className="review-button" disabled={!commitInput.trim()}>
                {i18nService.t('reviewLoadCommit')}
              </button>
            </form>
          )}
          {scope === ReviewScope.Commit && (
            <p className="review-hint">{i18nService.t('reviewCommitLimit')}</p>
          )}
        </div>
        {diff?.baseRef && (
          <div className="review-base">
            {i18nService.t('reviewBase')}: <code>{diff.baseRef}</code>
          </div>
        )}
        {updated && <p role="status">{i18nService.t('reviewUpdated')}</p>}
        {diff && !updated && !error && (
          <p className="review-hint">{i18nService.t('reviewSnapshot')}</p>
        )}
        {error && (
          <p role="alert">
            {i18nService.t(`reviewError_${error}`)} {diff && i18nService.t('reviewStale')}
          </p>
        )}
        {actionError && <p role="alert">{i18nService.t('reviewError_file')}</p>}
        {copyError && <p role="alert">{i18nService.t('reviewError_copy')}</p>}
      </header>
      <div className="review-body">
        <div className="review-main">
          <div className="review-search">
            <MagnifyingGlassIcon aria-hidden="true" />
            <input
              className="review-filter"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder={i18nService.t('reviewFilter')}
              aria-label={i18nService.t('reviewFilter')}
            />
          </div>
          <div
            className="review-content"
            aria-busy={loading}
            onScroll={event => {
              const top = event.currentTarget.getBoundingClientRect().top;
              for (const [path, node] of fileNodes.current) {
                if (node.getBoundingClientRect().bottom > top + 2) {
                  setSelectedFile(path);
                  break;
                }
              }
            }}
          >
            {scope === ReviewScope.Commit && !commit && (
              <p>{i18nService.t('reviewChooseCommit')}</p>
            )}
            {loading && !diff && <p role="status">{i18nService.t('reviewLoading')}</p>}
            {diff?.unavailableReason && (
              <p role="status">{i18nService.t(`reviewUnavailable_${diff.unavailableReason}`)}</p>
            )}
            {diff && !diff.unavailableReason && !files.length && (
              <div className="review-empty-state" role="status">
                <span className={`review-empty-icon${filter ? ' is-filtered' : ''}`}>
                  {filter ? (
                    <MagnifyingGlassIcon aria-hidden="true" />
                  ) : (
                    <CheckCircleIcon aria-hidden="true" />
                  )}
                </span>
                <p>{i18nService.t(filter ? 'reviewNoMatches' : 'reviewEmpty')}</p>
              </div>
            )}
            {files.slice(0, fileLimit).map(file => {
              const focused = file.path === focusedPath;
              const isExpanded =
                expanded.has(file.path) || (focused && !expanded.has(`closed:${file.path}`));
              return (
                <article
                  className={`review-file${selectedFile === file.path ? ' review-file-selected' : ''}`}
                  key={file.path}
                  ref={node => {
                    if (focused) focusNode.current = node;
                    if (node) fileNodes.current.set(file.path, node);
                    else fileNodes.current.delete(file.path);
                  }}
                >
                  <div className="review-file-titlebar">
                    <button
                      className="review-file-heading"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded(current => {
                          const next = new Set(current);
                          if (isExpanded) {
                            next.delete(file.path);
                            next.add(`closed:${file.path}`);
                          } else {
                            next.add(file.path);
                            next.delete(`closed:${file.path}`);
                          }
                          return next;
                        })
                      }
                    >
                      <ChevronRightIcon aria-hidden="true" className="review-chevron" />
                      <WorkspaceFileIcon fileName={file.path.split('/').pop() ?? file.path} />
                      <span
                        className={`review-status review-status-${file.status}`}
                        title={i18nService.t(`reviewStatus_${file.status}`)}
                      >
                        {{ added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[file.status]}
                      </span>
                      <span
                        className="review-path"
                        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                      >
                        <span className="review-directory">
                          {file.oldPath
                            ? `${file.oldPath} → `
                            : file.path.includes('/')
                              ? `${file.path.slice(0, file.path.lastIndexOf('/'))}/`
                              : ''}
                        </span>
                        <strong>{file.oldPath ? file.path : file.path.split('/').pop()}</strong>
                      </span>
                      <span className="review-count">
                        <span className="review-added">+{file.additions}</span>
                        <span className="review-deleted">−{file.deletions}</span>
                      </span>
                      {file.untracked && (
                        <span
                          className="review-file-badge"
                          title={i18nService.t('reviewUntracked')}
                          aria-label={i18nService.t('reviewUntracked')}
                        >
                          U
                        </span>
                      )}
                    </button>
                    <details
                      className="review-file-menu"
                      onKeyDown={event => {
                        if (event.key === 'Escape') {
                          event.currentTarget.open = false;
                          event.currentTarget.querySelector('summary')?.focus();
                        }
                      }}
                      onBlur={event => {
                        if (!event.currentTarget.contains(event.relatedTarget))
                          event.currentTarget.open = false;
                      }}
                    >
                      <summary
                        title={i18nService.t('reviewFileActions')}
                        aria-label={i18nService.t('reviewFileActions')}
                      >
                        <EllipsisHorizontalIcon aria-hidden="true" />
                      </summary>
                      <div className="review-controls review-file-actions">
                        <button
                          className="review-button"
                          onClick={() => void copy(file.path, `path:${file.path}`)}
                        >
                          {i18nService.t(
                            copied === `path:${file.path}` ? 'reviewCopied' : 'reviewCopyPath',
                          )}
                        </button>
                        {file.patch && (
                          <button
                            className="review-button"
                            onClick={() => void copy(file.patch!, `patch:${file.path}`)}
                          >
                            {i18nService.t(
                              copied === `patch:${file.path}` ? 'reviewCopied' : 'reviewCopyPatch',
                            )}
                          </button>
                        )}
                        {(['preview', 'files', 'editor'] as const)
                          .filter(
                            action => action !== 'editor' || window.electron.platform === 'win32',
                          )
                          .map(action => (
                            <button
                              key={action}
                              className="review-button"
                              disabled={!diff?.root || file.status === 'deleted' || actionPending}
                              onClick={() => void openFile(file.path, action)}
                            >
                              {i18nService.t(`reviewAction_${action}`)}
                            </button>
                          ))}
                      </div>
                    </details>
                  </div>
                  {isExpanded && (
                    <>
                      {!diff?.root && <p>{i18nService.t('reviewRemote')}</p>}
                      {file.status === 'deleted' && <p>{i18nService.t('reviewDeleted')}</p>}
                      {file.binary && <p>{i18nService.t('reviewBinary')}</p>}
                      {file.truncated && <p>{i18nService.t('reviewTruncated')}</p>}
                      {!file.binary && !file.patch && <p>{i18nService.t('reviewNoPatch')}</p>}
                      {file.patch && (
                        <SessionReviewPatch
                          key={`${key}:${file.path}`}
                          patch={file.patch}
                          path={file.path}
                          split={split}
                          wrap={wrap}
                        />
                      )}
                    </>
                  )}
                </article>
              );
            })}
            {files.length > fileLimit && (
              <button className="review-button" onClick={() => setFileLimit(value => value + 100)}>
                {i18nService.t('reviewMoreFiles')}
              </button>
            )}
          </div>
        </div>
        <nav className="review-navigation" aria-label={i18nService.t('reviewFileNavigation')}>
          <div className="review-navigation-title">{i18nService.t('reviewFilesChanged')}</div>
          {[
            ...new Set(
              files
                .slice(0, fileLimit)
                .map(file =>
                  file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '',
                ),
            ),
          ].map(directory => (
            <details key={directory} open className="review-directory-group">
              <summary>
                <ChevronRightIcon aria-hidden="true" />
                <span>{directory || i18nService.t('reviewWorkspace')}</span>
              </summary>
              {files
                .slice(0, fileLimit)
                .filter(
                  file =>
                    (file.path.includes('/')
                      ? file.path.slice(0, file.path.lastIndexOf('/'))
                      : '') === directory,
                )
                .map(file => (
                  <button
                    key={file.path}
                    className="review-navigation-file"
                    aria-label={file.path}
                    aria-current={selectedFile === file.path ? 'location' : undefined}
                    onClick={() => {
                      setSelectedFile(file.path);
                      setExpanded(current => {
                        const next = new Set(current);
                        next.add(file.path);
                        next.delete(`closed:${file.path}`);
                        return next;
                      });
                      fileNodes.current.get(file.path)?.scrollIntoView?.({ block: 'start' });
                    }}
                  >
                    <WorkspaceFileIcon fileName={file.path.split('/').pop() ?? file.path} />
                    <span>{file.path.split('/').pop()}</span>
                    <span
                      className={`review-nav-status review-status-${file.status}`}
                      aria-label={i18nService.t(`reviewStatus_${file.status}`)}
                    >
                      {{ added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[file.status]}
                    </span>
                  </button>
                ))}
            </details>
          ))}
          {files.length > fileLimit && (
            <button className="review-button" onClick={() => setFileLimit(value => value + 100)}>
              {i18nService.t('reviewMoreFiles')}
            </button>
          )}
        </nav>
      </div>
    </section>
  );
}
