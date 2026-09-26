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
  'rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised';

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

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-surface p-4"
      aria-label={t('storageTitle')}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{t('storageTitle')}</h3>
        <button
          type="button"
          className={buttonClass}
          disabled={busy || checking}
          onClick={() => void refresh()}
        >
          {t(checking ? 'storageRefreshing' : 'storageRefresh')}
        </button>
      </div>
      <p className="text-xs text-secondary">{t('storageScope')}</p>
      {error && (
        <p role="alert">
          {t(`storageError_${error}`)} {updatedAt && t('storageStale')}
        </p>
      )}
      {!status && !error && <p role="status">{t('storageLoading')}</p>}
      {policyError && (
        <p role="alert">
          {t('storagePolicyReadFailed')} {t(`storageError_${policyError}`)}
        </p>
      )}
      {policy && !policy.applied && <p role="status">{t('storageError_pending')}</p>}
      {status && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-secondary">{t(key)}</dt>
                <dd>{bytes(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {t('storageHot')}: {status.agents.reduce((n, a) => n + a.hotTranscripts, 0)} ·{' '}
            {t('storageCold')}: {status.agents.reduce((n, a) => n + a.coldTranscripts, 0)}
          </p>
          <details>
            <summary className="cursor-pointer text-sm">{t('storageAgents')}</summary>
            {status.agents.map(agent => (
              <div key={agent.agentId} className="mt-2 border-t border-border pt-2 text-xs">
                <strong>{agents.find(a => a.id === agent.agentId)?.name ?? agent.agentId}</strong>
                <p>
                  {t('storageDatabase')}: {bytes(agent.databaseBytes)} · {t('storageWal')}:{' '}
                  {bytes(agent.walBytes)} · {t('storageArchive')}: {bytes(agent.archiveBytes)}
                </p>
                <p>
                  {t('storageHot')}: {agent.hotTranscripts} · {t('storageCold')}:{' '}
                  {agent.coldTranscripts} · {t('storageEmbedded')}:{' '}
                  {bytes(agent.embeddedArchiveBytes)}
                </p>
              </div>
            ))}
          </details>
          <div className="text-xs" role="status">
            {status.maintenance.running ? (
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
            {status.maintenance.lastError && <p role="alert">{t('storageMaintenanceFailed')}</p>}
          </div>
        </>
      )}
      {updatedAt && (
        <p className="text-xs text-secondary">
          {t('storageUpdated')}: {new Date(updatedAt).toLocaleString()}
        </p>
      )}
      <fieldset
        disabled={!policy || busy || !!status?.maintenance.running}
        className="space-y-3 border-t border-border pt-3"
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => setEnabled(event.target.checked)}
          />
          {t('storageEnabled')}
        </label>
        <p className="text-xs text-secondary">{t('storageEnableHelp')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">
            {t('storageDays')}{' '}
            <input
              type="number"
              min="1"
              step="1"
              value={days}
              onChange={event => setDays(event.target.value)}
              className="w-24 rounded border border-border bg-surface-inset px-2 py-1"
            />
          </label>
          {[30, 60, 90].map(day => (
            <button
              type="button"
              className={buttonClass}
              key={day}
              onClick={() => setDays(String(day))}
            >
              {day}
            </button>
          ))}
        </div>
        {!validDays && <p role="alert">{t('storageError_invalid')}</p>}
      </fieldset>
      <p className="text-xs text-secondary">{t('storageIndependent')}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
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
        <p role="alert">
          {t(`storageError_${writeError}`)} {t('storageWriteNotReplayed')}
        </p>
      )}
      <p className="text-xs text-secondary">{t('storageRetention')}</p>
    </section>
  );
}
