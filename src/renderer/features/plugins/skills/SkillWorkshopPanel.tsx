import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  DocumentPlusIcon,
  DocumentTextIcon,
  EyeIcon,
  PencilSquareIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
  UserIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import type {
  SkillWorkshopChange,
  SkillWorkshopFile,
  SkillWorkshopInventory,
  SkillWorkshopResult,
} from '@shared/plugins/skillWorkshop';
import { SkillWorkshopAction, SkillWorkshopActor } from '@shared/plugins/skillWorkshop';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

const t = (key: string) => i18nService.t(key);
const unwrap = <T,>(result: SkillWorkshopResult<T>): T => {
  if (!result.success) throw new Error(result.error);
  return result.value;
};
const errorText = (error: unknown) => {
  const key = error instanceof Error ? error.message : '';
  return t(key.startsWith('skillWorkshop') ? key : 'skillWorkshopUnavailable');
};
const button =
  'rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed';
const iconButton =
  'flex h-8 w-8 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed';
const listButton =
  'block w-full rounded-md px-3 py-2.5 text-left text-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed';

const actionAppearance = {
  [SkillWorkshopAction.Create]: {
    Icon: PlusIcon,
    color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  [SkillWorkshopAction.Patch]: {
    Icon: PencilSquareIcon,
    color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  },
  [SkillWorkshopAction.WriteFile]: {
    Icon: DocumentPlusIcon,
    color: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
  [SkillWorkshopAction.RemoveFile]: {
    Icon: TrashIcon,
    color: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  },
  [SkillWorkshopAction.Archive]: {
    Icon: ArchiveBoxIcon,
    color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  [SkillWorkshopAction.Restore]: {
    Icon: ArrowUturnLeftIcon,
    color: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  },
};

function ActionIcon({ action }: { action: SkillWorkshopChange['action'] }) {
  const { Icon, color } = actionAppearance[action];
  const label = t('skillWorkshopAction.' + action);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ' + color}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

const shortDate = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
type Selection = { name: string; versionId?: string };
interface Props {
  onSkillsChanged: () => Promise<void>;
}

/** Reads only while open; native files and history remain authoritative. */
export default function SkillWorkshopPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  return (
    <>
      <div className="flex justify-end">
        <button
          ref={launcher}
          type="button"
          className={button}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {t('skillWorkshopTitle')}
        </button>
      </div>
      {open &&
        createPortal(
          <Modal
            onClose={close}
            closeOnBackdrop={false}
            className="w-[min(1040px,94vw)] max-h-[88vh] overflow-y-auto rounded-xl border border-border bg-surface shadow-2xl"
          >
            <WorkshopDialog {...props} onClose={close} titleId={titleId} />
          </Modal>,
          document.body,
        )}
    </>
  );
}

function WorkshopDialog({
  onSkillsChanged,
  onClose,
  titleId,
}: Props & { onClose: () => void; titleId: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const mutation = useRef(false);
  const initialSelection = useRef(true);
  const generation = useRef(0);
  const readGeneration = useRef(0);
  const [inventory, setInventory] = useState<SkillWorkshopInventory | null>(null);
  const [changes, setChanges] = useState<SkillWorkshopChange[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [file, setFile] = useState<SkillWorkshopFile | null>(null);
  const [confirm, setConfirm] = useState<'archive' | 'restore' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const invalidateReads = useCallback(() => {
    generation.current++;
    readGeneration.current++;
  }, []);

  const read = useCallback(async (next: Selection, filePath = 'SKILL.md') => {
    const token = ++readGeneration.current;
    // Keep the committed identity and document together until the replacement is ready.
    // Removing the document here collapses the centered dialog during every read.
    setConfirm(null);
    setReason('');
    setError('');
    setNotice('');
    setReading(true);
    try {
      const result = unwrap(
        await window.electron.skillWorkshop.read({
          agentId: MAIN_USER_AGENT_ID,
          ...next,
          filePath,
        }),
      );
      if (mounted.current && token === readGeneration.current) {
        setSelection(next);
        setFile(result);
      }
    } catch (failure) {
      if (mounted.current && token === readGeneration.current) setError(errorText(failure));
    } finally {
      if (mounted.current && token === readGeneration.current) setReading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const token = ++generation.current;
    readGeneration.current++;
    setSelection(null);
    setFile(null);
    setReading(false);
    setConfirm(null);
    setLoading(true);
    try {
      const api = window.electron.skillWorkshop;
      const [next, recent] = await Promise.all([
        api.list(MAIN_USER_AGENT_ID).then(unwrap),
        api.changes({ agentId: MAIN_USER_AGENT_ID, limit: 200 }).then(unwrap),
      ]);
      if (!mounted.current || token !== generation.current) return;
      setInventory(next);
      setChanges(recent);
      setError('');
      if (initialSelection.current) {
        initialSelection.current = false;
        if (next.skills[0]) void read({ name: next.skills[0].name });
      }
    } catch (failure) {
      if (!mounted.current || token !== generation.current) return;
      setInventory(null);
      setChanges([]);
      setError(errorText(failure));
    } finally {
      if (mounted.current && token === generation.current) setLoading(false);
    }
  }, [read]);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.focus();
    void refresh();
    const onFocus = () => {
      if (!mutation.current) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      invalidateReads();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, invalidateReads]);

  useEffect(() => {
    if (document.activeElement === document.body) dialog.current?.focus();
  }, [selection, confirm, busy]);

  const mutate = async () => {
    if (mutation.current || reading || loading || !selection || !confirm || !file) return;
    const selected = { ...selection };
    const kind = confirm;
    if (kind === 'restore' && !selected.versionId) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    readGeneration.current++;
    setSelection(null);
    setFile(null);
    setConfirm(null);
    let receipt: SkillWorkshopChange | null = null;
    let failureMessage = '';
    try {
      receipt = unwrap(
        kind === 'archive'
          ? await window.electron.skillWorkshop.archive({
              agentId: MAIN_USER_AGENT_ID,
              name: selected.name,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            })
          : await window.electron.skillWorkshop.restore({
              agentId: MAIN_USER_AGENT_ID,
              name: selected.name,
              versionId: selected.versionId!,
            }),
      );
    } catch (failure) {
      failureMessage = errorText(failure);
    }
    // Read-only reconciliation never resubmits an uncertain mutation.
    if (mounted.current) {
      await refresh();
      if (receipt) {
        setNotice(t('skillWorkshopChangeConfirmed'));
        try {
          await onSkillsChanged();
        } catch {
          setError(t('skillWorkshopRefreshAfterChangeFailed'));
        }
      } else {
        setError(failureMessage);
      }
    }
    mutation.current = false;
    if (mounted.current) setBusy(false);
  };
  const live =
    !!selection &&
    !selection.versionId &&
    inventory?.skills.some(skill => skill.name === selection.name);
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="text-foreground outline-none"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (!mutation.current) onClose();
        }
        if (event.key !== 'Tab') return;
        const items = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        );
        if (!items?.length) {
          event.preventDefault();
          return;
        }
        const first = items[0],
          last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between gap-6 border-b border-border bg-surface px-6 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {t('skillWorkshopTitle')}
          </h2>
          <p className="mt-1 text-xs leading-5 text-secondary">{t('skillWorkshopIntro')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={iconButton}
            aria-label={t('skillWorkshopRefresh')}
            title={t('skillWorkshopRefresh')}
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label={t('skillWorkshopClose')}
            title={t('skillWorkshopClose')}
            disabled={busy}
            onClick={onClose}
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="space-y-5 px-6 pb-5 pt-5">
        {loading && <p role="status">{t('skillWorkshopLoading')}</p>}
        {notice && (
          <p role="status" className="text-sm text-primary">
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap rounded-lg border border-red-500/30 p-3 text-sm text-red-500"
          >
            {error}
          </p>
        )}
        <div className="grid items-start gap-6 md:grid-cols-[224px_minmax(0,1fr)]">
          <aside className="max-h-[52vh] space-y-6 overflow-y-auto md:border-r md:border-border md:pr-5 max-md:border-b max-md:border-border max-md:pb-4">
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 px-3 text-xs font-medium text-secondary">
                <SparklesIcon className="h-4 w-4 text-blue-500" aria-hidden="true" />
                {t('skillWorkshopCurrent')}
              </h3>
              {inventory?.skills.length === 0 && (
                <p className="text-sm text-secondary">{t('skillWorkshopNoSkills')}</p>
              )}
              {inventory?.skills.map(skill => (
                <button
                  key={skill.name}
                  type="button"
                  className={
                    listButton +
                    ' ' +
                    (selection?.name === skill.name && !selection.versionId
                      ? 'bg-blue-500/10 text-foreground'
                      : 'text-secondary')
                  }
                  aria-pressed={selection?.name === skill.name && !selection.versionId}
                  disabled={busy || loading}
                  onClick={() => void read({ name: skill.name })}
                >
                  <span className="block break-words font-medium text-foreground">
                    {skill.name}
                  </span>
                  <span
                    className="mt-1 line-clamp-2 text-xs leading-5 text-secondary"
                    title={skill.description}
                  >
                    {skill.description}
                  </span>
                  {skill.useCount !== undefined && (
                    <span className="block text-xs text-secondary">
                      {t('skillWorkshopUseCount')} {skill.useCount}
                    </span>
                  )}
                </button>
              ))}
            </section>
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 px-3 text-xs font-medium text-secondary">
                <ClockIcon className="h-4 w-4 text-violet-500" aria-hidden="true" />
                {t('skillWorkshopVersions')}
              </h3>
              {inventory?.archived.map(skill => (
                <details key={skill.name} className="px-3 py-1">
                  <summary className="cursor-pointer break-words text-xs leading-6 text-secondary focus-visible:outline-primary">
                    {skill.name}
                    <span
                      role="img"
                      aria-label={t(
                        skill.live ? 'skillWorkshopStillLive' : 'skillWorkshopArchived',
                      )}
                      title={t(skill.live ? 'skillWorkshopStillLive' : 'skillWorkshopArchived')}
                      className={
                        'ml-2 inline-flex align-middle ' +
                        (skill.live
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400')
                      }
                    >
                      {skill.live ? (
                        <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <ArchiveBoxIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </span>
                  </summary>
                  <ul className="mt-2 space-y-2">
                    {skill.versions.map(version => (
                      <li key={version.id}>
                        <button
                          type="button"
                          disabled={busy || loading}
                          className={
                            listButton +
                            ' flex items-center gap-2 !px-2 ' +
                            (selection?.name === skill.name && selection.versionId === version.id
                              ? 'bg-violet-500/10'
                              : '')
                          }
                          aria-pressed={
                            selection?.name === skill.name && selection.versionId === version.id
                          }
                          aria-label={
                            new Date(version.createdAtMs).toLocaleString() +
                            ' · ' +
                            t('skillWorkshopAction.' + version.action) +
                            ' · ' +
                            version.id
                          }
                          title={
                            new Date(version.createdAtMs).toLocaleString() +
                            '\n' +
                            t('skillWorkshopAction.' + version.action) +
                            '\n' +
                            version.id
                          }
                          onClick={() => void read({ name: skill.name, versionId: version.id })}
                        >
                          <ActionIcon action={version.action} />
                          <span className="text-xs tabular-nums">
                            {shortDate(version.createdAtMs)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </section>
          </aside>
          <article className="relative min-w-0 overflow-hidden" aria-busy={reading}>
            {reading && (
              <p
                role="status"
                className="pointer-events-none absolute right-0 top-0 rounded bg-surface px-2 py-1 text-xs text-secondary"
              >
                {t('skillWorkshopFileLoading')}
              </p>
            )}
            {!selection && (
              <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
                <DocumentTextIcon className="h-7 w-7 text-secondary" aria-hidden="true" />
                <p className="max-w-xs text-xs leading-6 text-secondary">
                  {t('skillWorkshopSelectHint')}
                </p>
              </div>
            )}
            {selection && (
              <>
                <div className="min-h-16 space-y-1 pb-4 pr-28">
                  <h3 className="break-all text-lg font-semibold">{selection.name}</h3>
                  <p className="break-all text-xs text-secondary">
                    {selection.versionId
                      ? t('skillWorkshopSavedVersion') + ' ' + selection.versionId
                      : t('skillWorkshopLiveVersion')}
                  </p>
                </div>
                {file && (
                  <div className="space-y-4">
                    <label className="flex flex-wrap items-center gap-2 text-sm text-secondary">
                      {t('skillWorkshopFile')}
                      <select
                        aria-label={t('skillWorkshopFile')}
                        className="min-w-0 max-w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground focus-visible:outline-primary"
                        value={file.filePath}
                        disabled={busy || reading}
                        onChange={event => void read(selection, event.target.value)}
                      >
                        {file.files.map(path => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                    </label>
                    <pre className="h-[min(42vh,24rem)] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-4 font-mono text-[13px] leading-6 select-text">
                      {file.content || t('skillWorkshopNoContent')}
                    </pre>
                    {!confirm && (
                      <div className="flex flex-wrap gap-2">
                        {live && (
                          <button
                            type="button"
                            className={button}
                            disabled={busy || loading || reading}
                            onClick={() => setConfirm('archive')}
                          >
                            {t('skillWorkshopArchive')}
                          </button>
                        )}
                        {selection.versionId && (
                          <button
                            type="button"
                            className={button}
                            disabled={busy || loading || reading}
                            onClick={() => setConfirm('restore')}
                          >
                            {t('skillWorkshopRestore')}
                          </button>
                        )}
                      </div>
                    )}
                    {confirm && (
                      <section
                        className="space-y-3 rounded-lg border border-primary/40 p-3"
                        aria-label={t('skillWorkshopConfirmTitle')}
                      >
                        <p className="text-sm">
                          {t(
                            confirm === 'archive'
                              ? 'skillWorkshopArchiveConfirm'
                              : 'skillWorkshopRestoreConfirm',
                          )}
                        </p>
                        <p className="text-xs leading-5 text-secondary">
                          {t('skillWorkshopConcurrencyHint')}
                        </p>
                        <p className="break-all text-xs">
                          {selection.name}
                          {selection.versionId ? ' · ' + selection.versionId : ''}
                        </p>
                        {confirm === 'archive' && (
                          <label className="block text-sm">
                            {t('skillWorkshopReason')}
                            <textarea
                              maxLength={1000}
                              value={reason}
                              onChange={event => setReason(event.target.value)}
                              className="mt-1 block w-full rounded border border-border bg-surface p-2"
                            />
                          </label>
                        )}
                        <button
                          type="button"
                          className={button + ' border-primary/40 bg-primary/10 text-primary'}
                          disabled={busy || loading || reading}
                          onClick={() => void mutate()}
                        >
                          {t('skillWorkshopConfirm')}
                        </button>
                        <button
                          type="button"
                          className={button + ' ml-2'}
                          disabled={busy}
                          onClick={() => setConfirm(null)}
                        >
                          {t('skillWorkshopCancel')}
                        </button>
                      </section>
                    )}
                  </div>
                )}
              </>
            )}
          </article>
        </div>
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="flex items-center gap-2 text-xs font-medium text-secondary">
            <ClockIcon className="h-4 w-4 text-blue-500" aria-hidden="true" />
            {t('skillWorkshopChanges')}
            <span
              className="ml-auto rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-600 dark:text-blue-400"
              title={t('skillWorkshopChangesHint')}
              tabIndex={0}
              aria-label={t('skillWorkshopChangesHint')}
            >
              {t('skillWorkshopChangesLimit')}
            </span>
          </h3>
          {changes.length === 0 && (
            <p className="text-sm text-secondary">{t('skillWorkshopNoChanges')}</p>
          )}
          <ul className="max-h-44 divide-y divide-border overflow-y-auto">
            {changes.map(change => (
              <li key={change.id} className="space-y-1.5 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <ActionIcon action={change.action} />
                  <span className="break-all font-medium">{change.skillName}</span>
                  <span
                    role="img"
                    aria-label={t('skillWorkshopActor.' + change.actor)}
                    title={t('skillWorkshopActor.' + change.actor)}
                    className="text-secondary"
                  >
                    {change.actor === SkillWorkshopActor.User ? (
                      <UserIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <SparklesIcon className="h-3.5 w-3.5 text-violet-500" aria-hidden="true" />
                    )}
                  </span>
                  {change.versionId && (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-blue-600 hover:underline focus-visible:outline-primary disabled:opacity-50 disabled:cursor-not-allowed dark:text-blue-400"
                      aria-label={t('skillWorkshopBeforeChange')}
                      title={t('skillWorkshopBeforeChange')}
                      disabled={busy || loading}
                      onClick={() =>
                        void read({ name: change.skillName, versionId: change.versionId })
                      }
                    >
                      <EyeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('skillWorkshopBeforeChangeShort')}
                    </button>
                  )}
                  <time
                    className="text-xs text-secondary sm:ml-auto"
                    dateTime={new Date(change.createdAtMs).toISOString()}
                    title={new Date(change.createdAtMs).toLocaleString()}
                  >
                    {shortDate(change.createdAtMs)}
                  </time>
                </div>
                <p className="break-words pl-10 text-xs leading-5 text-secondary">
                  {change.summary}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
