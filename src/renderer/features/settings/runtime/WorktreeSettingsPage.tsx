import { ArrowPathIcon, ClockIcon } from '@heroicons/react/24/outline';
import type { ManagedWorktree } from '@shared/openclaw/worktrees';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { useEngineReadiness } from '@/app/shell/startup/routing/useEngineReadiness';
import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';
import GitBranchIcon from '@/shared/components/icons/GitBranchIcon';
import type { RootState } from '@/store';

import EngineSettingsGate from '../EngineSettingsGate';
import WorktreePolicySettings from './WorktreePolicySettings';

const t = (key: string) => i18nService.t(key);
const ownerLabels: Record<ManagedWorktree['ownerKind'], string> = {
  manual: 'worktreeOwnerManual',
  workboard: 'worktreeOwnerWorkboard',
  session: 'worktreeOwnerSession',
};

function WorktreeRecordCard({
  record,
  disabled,
  onRestore,
  onRemove,
}: {
  record: ManagedWorktree;
  disabled: boolean;
  onRestore: (record: ManagedWorktree) => void;
  onRemove: (record: ManagedWorktree) => void;
}) {
  const restorable = record.removedAt != null;
  const lastActive = new Date(record.lastActiveAt);
  const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';

  return (
    <li className="space-y-3.5 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <GitBranchIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h4 className="min-w-0 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                {record.name}
              </h4>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-foreground ${restorable ? 'bg-warning/10' : 'bg-success/10'}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${restorable ? 'bg-warning' : 'bg-success'}`}
                  aria-hidden="true"
                />
                {t(restorable ? 'worktreeRestorable' : 'worktreeActive')}
              </span>
            </div>
            <span className="inline-block max-w-full rounded-md bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-secondary [overflow-wrap:anywhere]">
              {record.branch}
            </span>
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => (restorable ? onRestore : onRemove)(record)}
          className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${restorable ? 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10' : 'border-border text-secondary hover:border-danger/20 hover:bg-danger/5 hover:text-danger'}`}
        >
          {t(restorable ? 'worktreeRestore' : 'worktreeRemove')}
        </button>
      </div>
      <dl className="divide-y divide-border rounded-lg border border-border bg-surface-inset text-xs leading-5">
        <div className="grid gap-x-3 px-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="font-medium text-secondary">{t('worktreeCheckoutPath')}</dt>
          <dd className="min-w-0 select-text font-mono text-foreground [overflow-wrap:anywhere]" dir="auto">
            {record.path}
          </dd>
        </div>
        <div className="grid gap-x-3 px-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="font-medium text-secondary">{t('worktreeSourceProject')}</dt>
          <dd className="min-w-0 select-text font-mono text-foreground [overflow-wrap:anywhere]" dir="auto">
            {record.repoRoot}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
        <span>{t(ownerLabels[record.ownerKind])}</span>
        <span className="inline-flex items-center gap-1.5">
          <ClockIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t('worktreeLastActive')}</span>
          <time dateTime={lastActive.toJSON() ?? undefined} className="tabular-nums">
            {lastActive.toLocaleString(locale)}
          </time>
        </span>
      </div>
      {record.runEndCleanup?.reason && (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground [overflow-wrap:anywhere]">
          {record.runEndCleanup.reason}
        </p>
      )}
    </li>
  );
}

export default function WorktreeSettingsPage() {
  return <EngineSettingsGate><WorktreeSettings /></EngineSettingsGate>;
}

function WorktreeSettings() {
  const engine = useEngineReadiness();
  const inventoryHeadingId = useId();
  const engineReady = useRef(engine.ready);
  engineReady.current = engine.ready;
  const active = useRef(true);
  const readGeneration = useRef(0);
  const mutationPending = useRef(false);
  const refreshPending = useRef(false);
  const showCheckbox = useSelector(
    (state: RootState) => state.cowork.config.showWorktreeCheckbox === true,
  );
  const [savingPreference, setSavingPreference] = useState(false);
  const [records, setRecords] = useState<ManagedWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!engineReady.current || mutationPending.current) {
      refreshPending.current = true;
      return;
    }
    refreshPending.current = false;
    const generation = ++readGeneration.current;
    setLoading(true);
    try {
      const result = await window.electron.openclaw.worktrees.list();
      if (!active.current || !engineReady.current || generation !== readGeneration.current) return;
      if (result.success) {
        setRecords(result.value);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    } finally {
      if (active.current && engineReady.current && generation === readGeneration.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    if (engine.ready) void load();
    else {
      readGeneration.current += 1;
      refreshPending.current = true;
    }
    return () => {
      active.current = false;
      readGeneration.current += 1;
    };
  }, [engine.ready, load]);

  const finishMutation = () => {
    mutationPending.current = false;
    if (!active.current) return;
    setBusy(null);
    if (refreshPending.current) void load();
  };

  const restore = async (record: ManagedWorktree) => {
    if (!engineReady.current || mutationPending.current) return;
    mutationPending.current = true;
    readGeneration.current += 1;
    setBusy(record.id);
    setError(null);
    try {
      const result = await window.electron.openclaw.worktrees.restore(record.id);
      if (result.success) refreshPending.current = true;
      else setError(result.error);
    } finally {
      finishMutation();
    }
  };

  const remove = async (record: ManagedWorktree) => {
    if (!engineReady.current || mutationPending.current) return;
    if (!window.confirm(t('worktreeRemoveConfirm'))) return;
    mutationPending.current = true;
    readGeneration.current += 1;
    setBusy(record.id);
    setError(null);
    try {
      const result = await window.electron.openclaw.worktrees.remove(record.id);
      if (!result.success) setError(result.error);
      else if (!result.value.removed)
        setError(result.value.snapshotError || t('worktreeRemoveFailed'));
      else refreshPending.current = true;
    } finally {
      finishMutation();
    }
  };

  const clean = async () => {
    if (!engineReady.current || mutationPending.current) return;
    mutationPending.current = true;
    readGeneration.current += 1;
    setBusy('gc');
    setError(null);
    try {
      const result = await window.electron.openclaw.worktrees.clean();
      if (result.success) refreshPending.current = true;
      else setError(result.error);
    } catch {
      setError(t('worktreeCleanupUnconfirmed'));
    } finally {
      finishMutation();
    }
  };

  const setShowCheckbox = async (showWorktreeCheckbox: boolean) => {
    setSavingPreference(true);
    try {
      const saved = await coworkService.updateConfig({ showWorktreeCheckbox });
      if (!saved) setError(t('worktreePreferenceSaveFailed'));
    } catch {
      setError(t('worktreePreferenceSaveFailed'));
    } finally {
      setSavingPreference(false);
    }
  };

  return (
    <div className="space-y-5">
      <label className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
        <span>
          <span className="block text-sm font-medium text-foreground">
            {t('worktreeShowCheckbox')}
          </span>
          <span className="mt-1 block text-xs text-secondary">
            {t('worktreeShowCheckboxDescription')}
          </span>
        </span>
        <input
          type="checkbox"
          checked={showCheckbox}
          disabled={savingPreference}
          onChange={event => void setShowCheckbox(event.target.checked)}
          className="h-4 w-4 accent-primary"
        />
      </label>
      <WorktreePolicySettings />
      <section aria-labelledby={inventoryHeadingId} className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h3 id={inventoryHeadingId} className="text-sm font-semibold text-foreground">
            {t('worktreeListTitle')}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={loading || busy !== null}
              onClick={() => void clean()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-inset hover:text-foreground disabled:opacity-50"
            >
              {t('worktreeClean')}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-inset disabled:opacity-50"
            >
              <ArrowPathIcon className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {t('worktreeRefresh')}
            </button>
          </div>
        </div>
        <div className="space-y-3 bg-surface-inset/40 p-3 sm:p-4">
          {(error || loadError) && (
            <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
              {error || loadError}
            </p>
          )}
          {loading ? (
            <p role="status" className="px-1 py-3 text-sm text-secondary">
              {t('worktreeLoading')}
            </p>
          ) : records.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-surface px-4 py-7 text-center">
              <GitBranchIcon className="h-5 w-5 text-secondary" />
              <p className="text-sm text-secondary">{t('worktreeEmpty')}</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {records.map(record => (
                <WorktreeRecordCard
                  key={record.id}
                  record={record}
                  disabled={busy !== null}
                  onRestore={record => void restore(record)}
                  onRemove={record => void remove(record)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
