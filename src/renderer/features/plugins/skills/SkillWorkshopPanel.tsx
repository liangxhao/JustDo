import { DocumentTextIcon } from '@heroicons/react/24/outline';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import type {
  SkillWorkshopChange,
  SkillWorkshopFile,
  SkillWorkshopInventory,
  SkillWorkshopResult,
} from '@shared/plugins/skillWorkshop';
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
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed';
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
            className="w-[min(1280px,94vw)] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface shadow-2xl"
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const invalidateReads = useCallback(() => {
    generation.current++;
    readGeneration.current++;
  }, []);

  const refresh = useCallback(async () => {
    const token = ++generation.current;
    readGeneration.current++;
    setSelection(null);
    setFile(null);
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
    } catch (failure) {
      if (!mounted.current || token !== generation.current) return;
      setInventory(null);
      setChanges([]);
      setError(errorText(failure));
    } finally {
      if (mounted.current && token === generation.current) setLoading(false);
    }
  }, []);

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

  const read = async (next: Selection, filePath = 'SKILL.md') => {
    const token = ++readGeneration.current;
    setSelection(next);
    setFile(null);
    setConfirm(null);
    setReason('');
    setError('');
    setNotice('');
    try {
      const result = unwrap(
        await window.electron.skillWorkshop.read({
          agentId: MAIN_USER_AGENT_ID,
          ...next,
          filePath,
        }),
      );
      if (mounted.current && token === readGeneration.current) setFile(result);
    } catch (failure) {
      if (mounted.current && token === readGeneration.current) setError(errorText(failure));
    }
  };

  const mutate = async () => {
    if (mutation.current || !selection || !confirm || !file) return;
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
      className="space-y-5 p-6 text-foreground outline-none"
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
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="flex items-center gap-2 text-xl font-semibold">
            <DocumentTextIcon className="h-6 w-6" />
            {t('skillWorkshopTitle')}
          </h2>
          <p className="mt-2 text-sm text-secondary">{t('skillWorkshopIntro')}</p>
          <p className="mt-1 text-xs text-secondary">{t('skillWorkshopConcurrencyHint')}</p>
        </div>
        <button type="button" className={button} disabled={busy} onClick={onClose}>
          {t('skillWorkshopClose')}
        </button>
      </header>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-secondary">
          {inventory
            ? t(inventory.mode === 'auto' ? 'skillWorkshopModeAuto' : 'skillWorkshopModeOff')
            : ''}
        </span>
        <button
          type="button"
          className={button}
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          {t('skillWorkshopRefresh')}
        </button>
      </div>
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
      <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-5 max-h-[65vh] overflow-y-auto">
          <section className="space-y-2">
            <h3 className="font-medium">{t('skillWorkshopCurrent')}</h3>
            {inventory?.skills.length === 0 && (
              <p className="text-sm text-secondary">{t('skillWorkshopNoSkills')}</p>
            )}
            {inventory?.skills.map(skill => (
              <button
                key={skill.name}
                type="button"
                className={button + ' block w-full text-left'}
                disabled={busy || loading}
                onClick={() => void read({ name: skill.name })}
              >
                <span className="block font-medium">{skill.name}</span>
                <span className="block text-xs text-secondary">{skill.description}</span>
                {skill.useCount !== undefined && (
                  <span className="block text-xs text-secondary">
                    {t('skillWorkshopUseCount')} {skill.useCount}
                  </span>
                )}
              </button>
            ))}
          </section>
          <section className="space-y-2">
            <h3 className="font-medium">{t('skillWorkshopVersions')}</h3>
            <p className="text-xs text-secondary">{t('skillWorkshopVersionsHint')}</p>
            {inventory?.archived.map(skill => (
              <details key={skill.name} className="rounded-lg border border-border p-2">
                <summary className="cursor-pointer text-sm">
                  {skill.name} ·{' '}
                  {t(skill.live ? 'skillWorkshopStillLive' : 'skillWorkshopArchived')}
                </summary>
                <ul className="mt-2 space-y-2">
                  {skill.versions.map(version => (
                    <li key={version.id}>
                      <button
                        type="button"
                        disabled={busy || loading}
                        className={button + ' w-full break-all text-left'}
                        onClick={() => void read({ name: skill.name, versionId: version.id })}
                      >
                        {new Date(version.createdAtMs).toLocaleString()} ·{' '}
                        {t('skillWorkshopAction.' + version.action)}
                        <span className="block text-xs">{version.id}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </section>
        </aside>
        <article className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          {!selection && <p className="text-sm text-secondary">{t('skillWorkshopSelectHint')}</p>}
          {selection && (
            <>
              <h3 className="break-all font-semibold">{selection.name}</h3>
              <p className="break-all text-xs text-secondary">
                {selection.versionId
                  ? t('skillWorkshopSavedVersion') + ' ' + selection.versionId
                  : t('skillWorkshopLiveVersion')}
              </p>
              {file && (
                <>
                  <label className="block text-sm">
                    {t('skillWorkshopFile')}
                    <select
                      aria-label={t('skillWorkshopFile')}
                      className="ml-2 rounded border border-border bg-surface p-1"
                      value={file.filePath}
                      disabled={busy}
                      onChange={event => void read(selection, event.target.value)}
                    >
                      {file.files.map(path => (
                        <option key={path} value={path}>
                          {path}
                        </option>
                      ))}
                    </select>
                  </label>
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words bg-background p-4 text-xs leading-6 select-text">
                    {file.content || t('skillWorkshopNoContent')}
                  </pre>
                  {!confirm && (
                    <div className="flex gap-2">
                      {live && (
                        <button
                          type="button"
                          className={button}
                          disabled={busy || loading}
                          onClick={() => setConfirm('archive')}
                        >
                          {t('skillWorkshopArchive')}
                        </button>
                      )}
                      {selection.versionId && (
                        <button
                          type="button"
                          className={button}
                          disabled={busy || loading}
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
                        className={button}
                        disabled={busy || loading}
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
                </>
              )}
            </>
          )}
        </article>
      </div>
      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="font-medium">{t('skillWorkshopChanges')}</h3>
        <p className="text-xs text-secondary">{t('skillWorkshopChangesHint')}</p>
        {changes.length === 0 && (
          <p className="text-sm text-secondary">{t('skillWorkshopNoChanges')}</p>
        )}
        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {changes.map(change => (
            <li key={change.id} className="rounded border border-border p-2 text-sm">
              <span>
                {change.skillName} · {t('skillWorkshopAction.' + change.action)} ·{' '}
                {t('skillWorkshopActor.' + change.actor)} ·{' '}
                {new Date(change.createdAtMs).toLocaleString()}
              </span>
              <p className="whitespace-pre-wrap text-secondary">{change.summary}</p>
              {change.versionId && (
                <button
                  type="button"
                  className={button + ' mt-1'}
                  disabled={busy || loading}
                  onClick={() => void read({ name: change.skillName, versionId: change.versionId })}
                >
                  {t('skillWorkshopBeforeChange')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
