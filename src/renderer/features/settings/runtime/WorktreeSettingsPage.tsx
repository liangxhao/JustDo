import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { ManagedWorktree } from '@shared/openclaw/worktrees';
import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

import WorktreePolicySettings from './WorktreePolicySettings';

const t = (key: string) => i18nService.t(key);

export default function WorktreeSettingsPage() {
  const showCheckbox = useSelector(
    (state: RootState) => state.cowork.config.showWorktreeCheckbox === true,
  );
  const [savingPreference, setSavingPreference] = useState(false);
  const [records, setRecords] = useState<ManagedWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.electron.openclaw.worktrees.list();
    if (result.success) {
      setRecords(result.value);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (record: ManagedWorktree) => {
    setBusy(record.id);
    const result = await window.electron.openclaw.worktrees.restore(record.id);
    if (result.success) await load();
    else setError(result.error);
    setBusy(null);
  };

  const remove = async (record: ManagedWorktree) => {
    if (!window.confirm(t('worktreeRemoveConfirm'))) return;
    setBusy(record.id);
    const result = await window.electron.openclaw.worktrees.remove(record.id);
    if (!result.success) setError(result.error);
    else if (!result.value.removed)
      setError(result.value.snapshotError || t('worktreeRemoveFailed'));
    else await load();
    setBusy(null);
  };

  const clean = async () => {
    setBusy('gc');
    const result = await window.electron.openclaw.worktrees.clean();
    if (result.success) await load();
    else setError(result.error);
    setBusy(null);
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
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('worktreeSettingsTitle')}</h2>
        <p className="mt-1 text-sm text-secondary">{t('worktreeSettingsDescription')}</p>
      </div>
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('worktreeListTitle')}</h3>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy !== null}
          className="rounded-lg border border-border px-3 py-2 text-sm text-foreground disabled:opacity-50"
        >
          <ArrowPathIcon className="mr-1 inline h-4 w-4" />
          {t('worktreeRefresh')}
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-secondary">{t('worktreeLoading')}</p>
      ) : records.length === 0 ? (
        <p className="rounded-lg border border-border p-5 text-sm text-secondary">
          {t('worktreeEmpty')}
        </p>
      ) : (
        <div className="space-y-3">
          {records.map(record => (
            <div key={record.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">
                    {record.name} <span className="text-xs text-secondary">{record.branch}</span>
                  </div>
                  <div className="mt-1 break-all text-xs text-secondary">{record.path}</div>
                  <div className="mt-1 break-all text-xs text-secondary">{record.repoRoot}</div>
                  <div className="mt-2 text-xs text-secondary">
                    {record.removedAt ? t('worktreeRestorable') : t('worktreeActive')} ·{' '}
                    {record.ownerKind} · {new Date(record.lastActiveAt).toLocaleString()}
                  </div>
                  {record.runEndCleanup?.reason && (
                    <div className="mt-1 text-xs text-amber-600">{record.runEndCleanup.reason}</div>
                  )}
                </div>
                <div className="flex gap-2">
                  {record.removedAt ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void restore(record)}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      {t('worktreeRestore')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void remove(record)}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-red-600 disabled:opacity-50"
                    >
                      {t('worktreeRemove')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={loading || busy !== null}
        onClick={() => void clean()}
        className="rounded-lg border border-border px-3 py-2 text-sm text-foreground disabled:opacity-50"
      >
        {t('worktreeClean')}
      </button>
    </div>
  );
}
