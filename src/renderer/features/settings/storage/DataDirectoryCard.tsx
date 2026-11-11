import { ArrowPathIcon, ChartPieIcon, Cog6ToothIcon, FolderIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import {
  StorageCleanupKind,
  StorageDirectoryCategory,
  type StorageDirectoryCategoryId,
  type StorageDirectoryUsage,
} from '@shared/storage/storageDirectory';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import BrowserCacheControls from './BrowserCacheControls';
import StorageCleanupDialog from './StorageCleanupDialog';
import StoragePathField from './StoragePathField';
import StorageRelocationControls from './StorageRelocationControls';
import UpgradeBackupControls from './UpgradeBackupControls';
import { useBrowserCacheCleanup } from './useBrowserCacheCleanup';
import { useUpgradeBackup } from './useUpgradeBackup';

const CLEANUP_SUCCESS_MS = 3000;
const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50';
const categoryColors: Record<StorageDirectoryCategoryId, string> = {
  [StorageDirectoryCategory.Native]: 'var(--justdo-primary)',
  [StorageDirectoryCategory.Backups]: '#f59e0b',
  [StorageDirectoryCategory.Cache]: '#14b8a6',
  [StorageDirectoryCategory.Plugins]: '#8b5cf6',
  [StorageDirectoryCategory.SpeechModels]: '#ec4899',
  [StorageDirectoryCategory.Other]: '#94a3b8',
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** exponent).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB'][exponent]}`;
}

export default function DataDirectoryCard() {
  const t = (key: string) => i18nService.t(key);
  const [directory, setDirectory] = useState<string>();
  const [bootstrapPath, setBootstrapPath] = useState<string>();
  const [locationError, setLocationError] = useState(false);
  const [usage, setUsage] = useState<StorageDirectoryUsage>();
  const [scanError, setScanError] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<{ kind: StorageCleanupKind }>();
  const [scanning, setScanning] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openingConfig, setOpeningConfig] = useState(false);
  const [openError, setOpenError] = useState(false);
  const alive = useRef(false);
  const scanningRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    void window.electron.storageDirectory
      .info()
      .then(result => {
        if (cancelled) return;
        if (result.success) {
          setDirectory(result.value.path);
          setBootstrapPath(result.value.bootstrapPath);
        }
        else setLocationError(true);
      })
      .catch(() => {
        if (!cancelled) setLocationError(true);
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!cleanupNotice) return;
    const timer = window.setTimeout(() => setCleanupNotice(undefined), CLEANUP_SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [cleanupNotice]);

  const scan = async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    setScanError(false);
    try {
      const result = await window.electron.storageDirectory.scan();
      if (!alive.current) return;
      if (result.success) setUsage(result.value);
      else setScanError(true);
      return result.success;
    } catch {
      if (alive.current) setScanError(true);
      return false;
    } finally {
      await backup.refreshStatus();
      scanningRef.current = false;
      if (alive.current) setScanning(false);
    }
  };

  const open = async (configuration = false) => {
    const setBusy = configuration ? setOpeningConfig : setOpening;
    setBusy(true);
    setOpenError(false);
    try {
      const result = await (configuration
        ? window.electron.storageDirectory.openConfig()
        : window.electron.storageDirectory.open());
      if (alive.current) setOpenError(!result.success);
    } catch {
      if (alive.current) setOpenError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const scanAfterCleanup = (kind: StorageCleanupKind, success: boolean) => {
    setCleanupNotice(success ? { kind } : undefined);
    return scan();
  };
  const cache = useBrowserCacheCleanup({
    disabled: scanning,
    onSettled: success => scanAfterCleanup(StorageCleanupKind.Cache, success),
  });
  const backup = useUpgradeBackup({
    disabled: scanning || cache.busy,
    onSettled: success => scanAfterCleanup(StorageCleanupKind.Backup, success),
  });
  const showCleanupNotice = cleanupNotice &&
    (cleanupNotice.kind === StorageCleanupKind.Backup || !cache.feedback.visible);
  const backupBytes = usage?.categories.find(category => category.id === StorageDirectoryCategory.Backups)?.bytes ?? 0;
  const showBackup = backup.status?.exists !== false &&
    (backupBytes > 0 || (backup.status?.exists && usage?.complete === false));
  const hasCleanupActions = (showBackup && backup.status?.exists) || cache.available;
  const totalBytes = (usage?.totalBytes ?? 0) - (showBackup ? 0 : backupBytes);
  const chartCategories = usage?.categories.filter(category =>
    category.id === StorageDirectoryCategory.Backups ? showBackup && category.bytes > 0
      : category.id !== StorageDirectoryCategory.SpeechModels || category.bytes > 0,
  ) ?? [];

  return (
    <section
      className="storage-directory overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
      aria-label={t('storageDirectoryTitle')}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 p-5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Cog6ToothIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
          {t('storageDirectoryConfigPath')}
        </span>
        <StoragePathField value={bootstrapPath ?? directory} copyLabel={t('storageDirectoryCopyConfig')}
          onOpen={() => void open(true)} opening={openingConfig} openLabel={t('storageDirectoryOpenConfig')} />
        <span aria-hidden="true" />
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FolderIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
          {t('storageDirectoryDataPath')}
        </span>
        {locationError ? (
          <p role="alert" className="text-sm text-secondary">
            {t('storageDirectoryUnavailable')}
          </p>
        ) : (
          <StoragePathField value={directory} onOpen={() => void open()}
            opening={opening} copyLabel={t('storageDirectoryCopyData')} openLabel={t('storageDirectoryOpenData')} />
        )}
        <StorageRelocationControls />
        {openError && (
          <p role="alert" className="col-span-3 text-xs text-secondary">
            {t('storageDirectoryOpenFailed')}
          </p>
        )}
      </div>
      <div className="space-y-4 border-t border-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="rounded-lg bg-primary/10 p-1.5 text-primary">
              <ChartPieIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            {t('storageDirectoryUsage')}
          </h4>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setCleanupNotice(undefined);
              void scan();
            }}
            disabled={scanning || backup.busy || cache.busy}
            aria-busy={scanning}
          >
            <ArrowPathIcon
              className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {t(
              scanning
                ? 'storageDirectoryScanning'
                : usage
                  ? 'storageDirectoryRescan'
                  : 'storageDirectoryScan',
            )}
          </button>
        </div>
        {scanError && (
          <p role="alert" className="text-xs leading-6 text-secondary">
            {t('storageDirectoryScanFailed')} {usage && t('storageStale')}
          </p>
        )}
        {!usage ? (
          <p role="status" className="text-xs leading-6 text-secondary">
            {t(scanning ? 'storageDirectoryScanPending' : 'storageDirectoryScanHint')}
          </p>
        ) : (
          <div className="space-y-4" aria-busy={scanning}>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-xs text-secondary">
                  {t(usage.complete ? 'storageDirectoryTotal' : 'storageDirectoryPartialTotal')}
                </p>
                <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-primary">
                  {formatBytes(totalBytes)}
                </p>
              </div>
              <p className="text-xs text-secondary">{new Date(usage.scannedAt).toLocaleString()}</p>
            </div>
            <div
              className="flex h-3 overflow-hidden rounded-full bg-surface-raised"
              role="img"
              aria-label={chartCategories
                .map(
                  category =>
                    `${t(`storageDirectoryCategory_${category.id}`)}: ${formatBytes(category.bytes)}`,
                )
                .join(' · ')}
            >
              {chartCategories.map(category => (
                <span
                  key={category.id}
                  className="border-r-2 border-surface last:border-r-0"
                  style={{
                    width: `${totalBytes ? (category.bytes / totalBytes) * 100 : 0}%`,
                    background: categoryColors[category.id],
                  }}
                />
              ))}
            </div>
            <dl className={`grid gap-x-3 gap-y-1 ${hasCleanupActions
              ? 'grid-cols-[minmax(0,1fr)_auto_auto]'
              : 'grid-cols-[minmax(0,1fr)_auto]'}`}>
              {Object.values(StorageDirectoryCategory).map(id => {
                const category = usage.categories.find(entry => entry.id === id);
                if (id === StorageDirectoryCategory.Backups && !showBackup) return null;
                if (id === StorageDirectoryCategory.SpeechModels && !category?.bytes) return null;
                const showHint = id !== StorageDirectoryCategory.Backups;
                return (
                  <div
                    key={id}
                    className="col-span-full grid grid-cols-subgrid items-center rounded-lg px-3 py-2.5 text-xs hover:bg-surface-raised/60"
                  >
                    <dt className="flex min-w-0 items-center gap-2.5 text-foreground"
                      title={showHint ? t(`storageDirectoryCategoryHint_${id}`) : undefined}>
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: categoryColors[id] }}
                      />
                      {t(`storageDirectoryCategory_${id}`)}
                      {showHint && (
                        <InformationCircleIcon className="h-3.5 w-3.5 shrink-0 text-secondary/50" aria-hidden="true" />
                      )}
                    </dt>
                    <dd className={`grid items-center text-right text-foreground ${hasCleanupActions ? 'col-span-2 grid-cols-subgrid' : ''}`}>
                      <span className="font-medium tabular-nums">
                        {category && (id !== StorageDirectoryCategory.Backups || category.bytes > 0)
                          ? formatBytes(category.bytes) : '—'}
                      </span>
                      {hasCleanupActions && (
                        <span className="flex justify-end">
                          {id === StorageDirectoryCategory.Backups && (
                            <UpgradeBackupControls backup={backup} disabled={scanning || cache.busy} />
                          )}
                          {id === StorageDirectoryCategory.Cache && (
                            <BrowserCacheControls cache={cache} disabled={scanning || backup.busy} />
                          )}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}
        {showCleanupNotice && (
          <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
            {t(cleanupNotice.kind === StorageCleanupKind.Backup ? 'upgradeBackupDeleted' : 'storageDirectoryCacheCleared')}
          </p>
        )}
        {cache.error && !cache.feedback.visible && <p role="alert" className="text-xs leading-6 text-red-600 dark:text-red-300">{t(`storageDirectoryCacheError_${cache.error}`)}</p>}
        {(backup.error || backup.statusFailed) && (
          <p role="alert" className="text-xs leading-6 text-red-600 dark:text-red-300">
            {t(backup.error ? `upgradeBackupError_${backup.error}` : 'upgradeBackupStatusFailed')}
            {backup.outcomeUnknown && ` ${t('storageCleanupUnknown')}`}
          </p>
        )}
      </div>
      <StorageCleanupDialog feedback={cache.feedback} onConfirm={() => void cache.confirm()} />
    </section>
  );
}
