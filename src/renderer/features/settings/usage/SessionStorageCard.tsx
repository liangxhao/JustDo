import type {
  SessionStorageErrorCode,
  SessionStoragePolicy,
  SessionStorageStatus,
} from '@shared/openclaw/sessionStorage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

const t = (key: string) => i18nService.t(key);
export const totalSessionStorageBytes = (status: SessionStorageStatus) =>
  status.agents.reduce(
    (sum, agent) => sum + agent.databaseBytes + agent.walBytes + agent.archiveBytes,
    0,
  );
const bytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
};
const buttonClass =
  'inline-flex min-h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-raised disabled:text-secondary disabled:hover:bg-surface-raised';
const primaryButtonClass =
  'inline-flex min-h-9 items-center justify-center rounded-lg border border-primary bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-raised disabled:text-secondary';

export default function SessionStorageCard() {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [status, setStatus] = useState<SessionStorageStatus | null>(null);
  const [policy, setPolicy] = useState<SessionStoragePolicy | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState('30');
  const [error, setError] = useState<SessionStorageErrorCode | null>(null);
  const [policyError, setPolicyError] = useState<SessionStorageErrorCode | null>(null);
  const [writeError, setWriteError] = useState<SessionStorageErrorCode | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const tickRef = useRef<() => void>(() => {});
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refs = useRef({
    alive: false,
    generation: 0,
    reading: false,
    writing: false,
    dirty: false,
    running: false,
    resetPolicy: false,
  });
  const dirty = !!policy && (enabled !== policy.enabled || Number(days) !== policy.afterDays);
  refs.current.dirty = dirty;
  refs.current.running = status?.maintenance.running === true;

  const adopt = useCallback((next: SessionStoragePolicy) => {
    setPolicy(next);
    setEnabled(next.enabled);
    setDays(String(next.afterDays));
  }, []);

  const refresh = useCallback(async () => {
    const ref = refs.current;
    const api = window.electron.cowork.sessionStorage;
    if (!ref.alive || ref.reading || ref.writing || document.hidden) return;
    if (!api) {
      setError('unsupported');
      return;
    }
    const generation = ref.generation;
    ref.reading = true;
    setChecking(true);
    try {
      const [stats, settings] = await Promise.all([api.getStatus(), api.getPolicy()]);
      if (!ref.alive || generation !== ref.generation) return;
      if (stats.success) {
        setStatus(stats.value);
        setUpdatedAt(Date.now());
      }
      if (settings.success && (!ref.dirty || ref.resetPolicy)) {
        adopt(settings.value);
        ref.resetPolicy = false;
      }
      setError(!stats.success ? stats.code : null);
      setPolicyError(!settings.success ? settings.code : null);
      if (stats.success && settings.success) setUncertain(false);
    } catch {
      if (ref.alive && generation === ref.generation) setError('unavailable');
    } finally {
      ref.reading = false;
      if (ref.alive && generation === ref.generation) setChecking(false);
      // React may restart the effect while this read is in flight. Its response
      // belongs to the previous lifecycle, so immediately read for the new one.
      else if (ref.alive) tickRef.current();
    }
  }, [adopt]);

  useEffect(() => {
    const ref = refs.current;
    ref.alive = true;
    ref.generation += 1;
    const generation = ref.generation;
    const tick = async () => {
      clearTimeout(timerRef.current);
      await refresh();
      if (ref.alive && generation === ref.generation && !document.hidden) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void tick(), ref.running ? 2000 : 15000);
      }
    };
    tickRef.current = () => void tick();
    const focus = () => {
      if (!document.hidden) void tick();
    };
    const visibility = () => {
      clearTimeout(timerRef.current);
      if (!document.hidden) void tick();
    };
    void tick();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      ref.alive = false;
      ref.generation += 1;
      clearTimeout(timerRef.current);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh]);

  useEffect(() => {
    if (status?.maintenance.running && !document.hidden) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => tickRef.current(), 2000);
    }
  }, [status?.maintenance.running]);

  const write = async (save: boolean) => {
    const ref = refs.current;
    if (!policy || ref.writing || ref.reading) return;
    const generation = ref.generation;
    ref.writing = true;
    setBusy(true);
    setWriteError(null);
    setUncertain(true);
    try {
      const api = window.electron.cowork.sessionStorage;
      if (save) {
        const result = await api.savePolicy({
          enabled,
          afterDays: Number(days),
          revision: policy.revision,
        });
        if (!ref.alive || generation !== ref.generation) return;
        if (result.success) adopt(result.value);
        else setWriteError(result.code);
        ref.resetPolicy = true;
      } else {
        const result = await api.run();
        if (!ref.alive || generation !== ref.generation) return;
        if (result.success) setStatus(result.value);
        else setWriteError(result.code);
      }
    } catch {
      if (ref.alive && generation === ref.generation) setWriteError('unavailable');
      if (save) ref.resetPolicy = true;
    } finally {
      ref.writing = false;
      if (ref.alive && generation === ref.generation) {
        setBusy(false);
        await refresh();
      }
    }
  };
  const validDays = /^\d+$/.test(days) && Number.isSafeInteger(Number(days)) && Number(days) > 0;
  const unavailable =
    !policy ||
    !status ||
    !!error ||
    !!policyError ||
    busy ||
    checking ||
    uncertain ||
    status.maintenance.running;
  const metrics = status
    ? ([
        ['storageTotal', totalSessionStorageBytes(status)],
        ['storageDatabase', status.agents.reduce((n, a) => n + a.databaseBytes, 0)],
        ['storageWal', status.agents.reduce((n, a) => n + a.walBytes, 0)],
        ['storageArchive', status.agents.reduce((n, a) => n + a.archiveBytes, 0)],
      ] as const)
    : [];
  const hotCount = status?.agents.reduce((n, a) => n + a.hotTranscripts, 0) ?? 0;
  const coldCount = status?.agents.reduce((n, a) => n + a.coldTranscripts, 0) ?? 0;

  return (
    <section className="space-y-5" aria-label={t('storageTitle')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{t('storageTitle')}</h3>
          <p className="mt-1 text-xs text-secondary">{t('storageScope')}</p>
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={busy || checking}
          onClick={() => void refresh()}
        >
          {t(checking ? 'storageRefreshing' : 'storageRefresh')}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-border bg-surface-raised px-4 py-3 text-sm"
        >
          {t(`storageError_${error}`)} {updatedAt && t('storageStale')}
        </p>
      )}
      {!status && !error && <p role="status">{t('storageLoading')}</p>}
      {policyError && (
        <p
          role="alert"
          className="rounded-lg border border-border bg-surface-raised px-4 py-3 text-sm"
        >
          {t('storagePolicyReadFailed')} {t(`storageError_${policyError}`)}
        </p>
      )}
      {status && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{t('storageOverview')}</h4>
            {updatedAt && (
              <span className="text-xs text-secondary">
                {t('storageUpdated')}: {new Date(updatedAt).toLocaleString()}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {metrics.map(([key, value]) => (
              <div key={key} className="rounded-lg bg-surface-raised px-3 py-3">
                <dt className="text-xs text-secondary">{t(key)}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {bytes(value)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-sm">
            <span>
              {t('storageHot')}: <strong className="tabular-nums">{hotCount}</strong>
            </span>
            <span>
              {t('storageCold')}: <strong className="tabular-nums">{coldCount}</strong>
            </span>
          </div>
          <details className="border-t border-border pt-3">
            <summary className="cursor-pointer text-sm font-medium">{t('storageAgents')}</summary>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] border-collapse text-xs">
                <thead className="bg-surface-raised text-secondary">
                  <tr>
                    {[
                      'storageAssistant',
                      'storageDatabase',
                      'storageWal',
                      'storageArchive',
                      'storageHot',
                      'storageCold',
                      'storageEmbedded',
                    ].map((key, index) => (
                      <th
                        key={key}
                        scope="col"
                        className={`px-3 py-2.5 font-medium ${index === 0 ? 'text-left' : 'text-right'}`}
                      >
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {status.agents.map(agent => (
                    <tr key={agent.agentId} className="border-t border-border">
                      <th scope="row" className="px-3 py-2.5 text-left font-medium text-foreground">
                        {agents.find(a => a.id === agent.agentId)?.name ?? agent.agentId}
                      </th>
                      {[
                        bytes(agent.databaseBytes),
                        bytes(agent.walBytes),
                        bytes(agent.archiveBytes),
                        agent.hotTranscripts,
                        agent.coldTranscripts,
                        bytes(agent.embeddedArchiveBytes),
                      ].map((value, index) => (
                        <td
                          key={index}
                          className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums"
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-raised px-4 py-3">
          <h4 className="text-sm font-semibold">{t('storageManagement')}</h4>
          <p className="mt-1 text-xs text-secondary">{t('storageIndependent')}</p>
        </div>
        <div className="space-y-4 p-4">
          <div className="text-sm" role="status">
            <span className="font-medium">{t('storageMaintenance')}：</span>{' '}
            {!status ? (
              t('storageLoading')
            ) : status.maintenance.running ? (
              t('storageRunning')
            ) : status.maintenance.lastCompletedAt ? (
              <>
                {t('storageCompleted')}:{' '}
                {new Date(status.maintenance.lastCompletedAt).toLocaleString()} ·{' '}
                {t('storageArchivedCount')}: {status.maintenance.archivedTranscripts} ·{' '}
                {t('storageExternalizedCount')}: {status.maintenance.externalizedTranscripts}
              </>
            ) : (
              t('storageNoRun')
            )}
            {status?.maintenance.lastError && (
              <p role="alert" className="mt-2 text-sm">
                {t('storageMaintenanceFailed')}
              </p>
            )}
          </div>
          {policy && !policy.applied && (
            <p role="status" className="rounded-lg bg-surface-raised p-3 text-sm">
              {t('storageError_pending')}
            </p>
          )}
          <fieldset
            disabled={!policy || busy || !!status?.maintenance.running}
            className="space-y-4 border-t border-border pt-4"
          >
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={enabled}
                onChange={event => setEnabled(event.target.checked)}
              />
              <span>
                <span className="font-medium">{t('storageEnabled')}</span>
                <span className="mt-1 block text-xs leading-relaxed text-secondary">
                  {t('storageEnableHelp')}
                </span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                {t('storageDays')}
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={days}
                  onChange={event => setDays(event.target.value)}
                  className="h-9 w-24 rounded-lg border border-border bg-surface-inset px-2 text-sm font-normal tabular-nums"
                />
              </label>
              <div className="flex gap-1.5">
                {[30, 60, 90].map(day => (
                  <button
                    type="button"
                    className={`${buttonClass} ${days === String(day) ? 'border-primary text-primary' : ''}`}
                    key={day}
                    onClick={() => setDays(String(day))}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>
            {!validDays && <p role="alert">{t('storageError_invalid')}</p>}
          </fieldset>
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!!unavailable || !dirty || !validDays}
              onClick={() => void write(true)}
            >
              {t('storageSave')}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={!!unavailable || dirty || !validDays || !policy?.enabled || !policy.applied}
              onClick={() => void write(false)}
            >
              {t('storageRun')}
            </button>
          </div>
          {!policy?.enabled && (
            <p className="text-xs text-secondary">{t('storageRunRequiresEnabled')}</p>
          )}
          {uncertain && <p role="status">{t('storageConfirming')}</p>}
          {writeError && (
            <p role="alert" className="rounded-lg bg-surface-raised p-3 text-sm">
              {t(`storageError_${writeError}`)} {t('storageWriteNotReplayed')}
            </p>
          )}
        </div>
      </div>
      <p className="px-1 text-xs leading-relaxed text-secondary">{t('storageRetention')}</p>
    </section>
  );
}
