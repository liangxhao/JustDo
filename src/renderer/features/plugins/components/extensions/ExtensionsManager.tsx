import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  ExtensionImportProgress,
  ExtensionImportStage,
  InstalledOpenClawExtension,
} from '@shared/openclaw/extensions';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import PuzzleIcon from '@/shared/components/icons/PuzzleIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

type ExtensionTab = 'installed' | 'marketplace';

const getImportStageLabel = (stage: ExtensionImportStage): string => {
  switch (stage) {
    case 'preparing':
      return i18nService.t('extensionImportStagePreparing');
    case 'extracting':
      return i18nService.t('extensionImportStageExtracting');
    case 'validating':
      return i18nService.t('extensionImportStageValidating');
    case 'preparing_runtime':
      return i18nService.t('extensionImportStagePreparingRuntime');
    case 'installing':
      return i18nService.t('extensionImportStageInstalling');
    case 'installing_dependencies':
      return i18nService.t('extensionImportStageInstallingDependencies');
    case 'restarting_gateway':
      return i18nService.t('extensionImportStageRestartingGateway');
    case 'completed':
      return i18nService.t('extensionImportStageCompleted');
  }
};

const ExtensionsManager: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ExtensionTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importError, setImportError] = useState('');
  const [importErrors, setImportErrors] = useState<{ fileName: string; error: string }[]>([]);
  const [extensions, setExtensions] = useState<InstalledOpenClawExtension[]>([]);
  const [loadingExtensions, setLoadingExtensions] = useState(true);
  const [importProgress, setImportProgress] = useState<ExtensionImportProgress | null>(null);
  const [importElapsedSeconds, setImportElapsedSeconds] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<InstalledOpenClawExtension | null>(null);
  const [deletingExtensionId, setDeletingExtensionId] = useState<string | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);
  const [togglingExtensionId, setTogglingExtensionId] = useState<string | null>(null);
  const extensionActionBusy =
    importing || deletingExtensionId !== null || togglingExtensionId !== null;

  const loadExtensions = useCallback(async () => {
    try {
      const result = await window.electron.extensions.list();
      if (!result.success) throw new Error(result.error || i18nService.t('extensionListFailed'));
      setExtensions(result.extensions);
      return result.extensions;
    } catch (error) {
      setImportError(error instanceof Error ? error.message : i18nService.t('extensionListFailed'));
      return null;
    } finally {
      setLoadingExtensions(false);
    }
  }, []);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  useEffect(
    () => window.electron.extensions.onImportProgress(progress => setImportProgress(progress)),
    [],
  );

  useEffect(() => {
    if (!importing) return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setImportElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [importing]);

  const filteredExtensions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return extensions;
    return extensions.filter(
      extension =>
        extension.name.toLowerCase().includes(query) ||
        extension.id.toLowerCase().includes(query) ||
        extension.description.toLowerCase().includes(query),
    );
  }, [extensions, searchQuery]);

  const handleImportExtensions = async (sourceType: 'folders' | 'archives') => {
    if (extensionActionBusy) return;

    try {
      setImportPickerOpen(false);
      setImporting(true);
      setImportSuccess(null);
      setImportError('');
      setImportErrors([]);
      setImportProgress(null);
      setImportElapsedSeconds(0);

      const result =
        sourceType === 'folders'
          ? await window.electron.dialog.selectFolders({
              title: i18nService.t('selectExtensionFolders'),
            })
          : await window.electron.dialog.selectFiles({
              title: i18nService.t('selectExtensionArchives'),
              filters: [
                {
                  name: i18nService.t('extensionArchiveFiles'),
                  extensions: ['zip', 'tar', 'gz', 'tgz'],
                },
              ],
            });

      if (!result.success || !result.paths?.length) return;

      const results = [];
      for (const [index, sourcePath] of result.paths.entries()) {
        const requestId = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
        const importResult = await window.electron.extensions.importPath({ requestId, sourcePath });
        results.push({ sourcePath, ...importResult });
      }

      const succeeded = results.filter(item => item.success);
      const failed = results.filter(item => !item.success);
      // Reconcile with disk even when a later installer step reports failure. OpenClaw
      // may have already published the extension before its CLI or Gateway restart fails.
      await loadExtensions();
      if (succeeded.length > 0) {
        const labels = succeeded
          .map(item => item.extensionId || item.sourcePath.split(/[/\\]/).pop())
          .filter(Boolean)
          .join(', ');
        setImportSuccess(labels);
        setTimeout(() => setImportSuccess(null), 5000);
      }
      if (failed.length > 0) {
        setImportErrors(
          failed.map(item => ({
            fileName: item.sourcePath.split(/[/\\]/).pop() || item.sourcePath,
            error: item.failedStage
              ? i18nService
                  .t('extensionImportFailedAtStage')
                  .replace('{stage}', getImportStageLabel(item.failedStage))
                  .replace('{error}', item.error || i18nService.t('extensionImportFailed'))
              : item.error || i18nService.t('extensionImportFailed'),
          })),
        );
      }
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : i18nService.t('extensionImportFailed'),
      );
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || extensionActionBusy) return;
    const extension = pendingDelete;
    try {
      setDeletingExtensionId(extension.id);
      setImportError('');
      const result = await window.electron.extensions.delete({ extensionId: extension.id });
      if (!result.success) {
        throw new Error(result.error || i18nService.t('extensionDeleteFailed'));
      }
      setPendingDelete(null);
      setDeleteSuccess(extension.name);
      window.setTimeout(() => setDeleteSuccess(null), 3000);
    } catch (error) {
      setImportError(
        `${i18nService.t('extensionDeleteFailed')}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      const latestExtensions = await loadExtensions();
      if (latestExtensions && !latestExtensions.some(item => item.id === extension.id)) {
        setPendingDelete(null);
      }
      setDeletingExtensionId(null);
    }
  };

  const handleToggleExtension = async (extension: InstalledOpenClawExtension) => {
    if (extensionActionBusy) return;
    try {
      setTogglingExtensionId(extension.id);
      setImportError('');
      const result = await window.electron.extensions.setEnabled({
        extensionId: extension.id,
        enabled: !extension.enabled,
      });
      if (!result.success) {
        throw new Error(result.error || i18nService.t('extensionStatusUpdateFailed'));
      }
    } catch (error) {
      setImportError(
        `${i18nService.t('extensionStatusUpdateFailed')}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await loadExtensions();
      setTogglingExtensionId(null);
    }
  };

  const tabClass = (tab: ExtensionTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative ${
      activeTab === tab ? 'text-foreground' : 'text-secondary hover:hover:text-foreground'
    }`;

  const tabIndicatorClass = (tab: ExtensionTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-primary' : 'bg-transparent'
    }`;

  return (
    <div className="space-y-4">
      {importError && <ErrorMessage message={importError} onClose={() => setImportError('')} />}

      {importErrors.length > 0 && (
        <div className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          <div className="flex items-center justify-between">
            <span className="font-medium">{i18nService.t('extensionImportFailed')}</span>
            <button
              type="button"
              onClick={() => setImportErrors([])}
              className="rounded p-1 transition-colors hover:bg-red-500/20"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <ul className="list-inside list-disc space-y-1 text-xs">
            {importErrors.map(item => (
              <li key={`${item.fileName}:${item.error}`}>
                <span className="font-medium">{item.fileName}:</span> {item.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {importSuccess && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-600">
          {i18nService.t('extensionImportSuccess').replace('{extensionId}', importSuccess)}
        </div>
      )}

      {deleteSuccess && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-600">
          {i18nService.t('extensionDeleteSuccess').replace('{name}', deleteSuccess)}
        </div>
      )}

      {importing && importProgress && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {importProgress.sourcePath.split(/[/\\]/).pop() || importProgress.sourcePath}
              </div>
              <div className="mt-0.5 text-xs text-secondary">
                {getImportStageLabel(importProgress.stage)}
              </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-secondary">
              {importProgress.percent}% ·{' '}
              {i18nService
                .t('extensionImportElapsed')
                .replace('{seconds}', String(importElapsedSeconds))}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-raised">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${importProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="sticky top-0 z-10 bg-background pb-4 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border">
          <div className="flex min-w-0 items-center">
            <button
              type="button"
              onClick={() => setActiveTab('installed')}
              className={tabClass('installed')}
            >
              {i18nService.t('extensionInstalled')}
              <div className={tabIndicatorClass('installed')} />
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('marketplace')}
              className={tabClass('marketplace')}
            >
              {i18nService.t('extensionMarketplace')}
              <div className={tabIndicatorClass('marketplace')} />
            </button>
          </div>
          <p className="min-w-0 truncate pb-2 text-right text-sm text-secondary">
            {i18nService.t('extensionsDescription')}
          </p>
        </div>
      </div>

      {activeTab === 'installed' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
              <input
                type="text"
                placeholder={i18nService.t('searchExtensions')}
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="w-full sm:ml-auto sm:w-auto">
              <Tooltip
                className="w-full sm:w-auto"
                content={i18nService.t('importExtensionTooltip')}
                position="bottom"
              >
                <button
                  type="button"
                  onClick={() => setImportPickerOpen(true)}
                  disabled={extensionActionBusy}
                  className={`flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised hover:text-foreground sm:w-auto ${
                    extensionActionBusy ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  <ArrowUpTrayIcon className="h-4 w-4" />
                  <span>
                    {importing
                      ? i18nService.t('importExtensionProgress')
                      : i18nService.t('importExtension')}
                  </span>
                </button>
              </Tooltip>
            </div>
          </div>

          {loadingExtensions ? (
            <div className="py-10 text-center text-sm text-secondary">
              {i18nService.t('loading')}
            </div>
          ) : filteredExtensions.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 px-4 py-10 text-center">
              <div className="max-w-md space-y-3">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-surface-raised text-secondary">
                  <PuzzleIcon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-semibold text-foreground">
                  {searchQuery
                    ? i18nService.t('noExtensionsMatched')
                    : i18nService.t('noExtensionsInstalled')}
                </h3>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredExtensions.map(extension => (
                <article
                  key={extension.id}
                  className="rounded-xl border border-border bg-surface p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-primary">
                      <PuzzleIcon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {extension.name}
                        </h3>
                        {extension.version && (
                          <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-secondary">
                            v{extension.version}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-secondary">{extension.id}</div>
                      {extension.description && (
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-secondary">
                          {extension.description}
                        </p>
                      )}
                      {extension.missingRequirements.length > 0 && (
                        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
                          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            {i18nService
                              .t('extensionMissingRequirements')
                              .replace('{requirements}', extension.missingRequirements.join(', '))}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Tooltip
                        content={i18nService.t(
                          extension.enabled ? 'extensionDisable' : 'extensionEnable',
                        )}
                        position="bottom"
                      >
                        <button
                          type="button"
                          role="switch"
                          aria-checked={extension.enabled}
                          aria-label={i18nService.t(
                            extension.enabled ? 'extensionDisable' : 'extensionEnable',
                          )}
                          onClick={() => void handleToggleExtension(extension)}
                          disabled={extensionActionBusy}
                          className={`flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            extension.enabled ? 'bg-primary' : 'bg-border'
                          }`}
                        >
                          <span
                            className={`h-3.5 w-3.5 rounded-full bg-white shadow-md transition-transform ${
                              extension.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </button>
                      </Tooltip>
                      <Tooltip content={i18nService.t('extensionDelete')} position="bottom">
                        <button
                          type="button"
                          onClick={() => setPendingDelete(extension)}
                          disabled={extensionActionBusy}
                          className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={i18nService.t('extensionDelete')}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'marketplace' && (
        <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 px-4 py-10 text-center">
          <div className="max-w-md space-y-3">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-surface-raised text-secondary">
              <PuzzleIcon className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">
                {i18nService.t('commonComingSoon')}
              </h3>
            </div>
          </div>
        </div>
      )}

      {importPickerOpen &&
        createPortal(
          <Modal
            onClose={() => setImportPickerOpen(false)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('importExtension')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('selectExtensionSourceDescription')}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleImportExtensions('folders')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <FolderIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectExtensionFolders')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectExtensionFoldersDescription')}
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleImportExtensions('archives')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <ArchiveBoxIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectExtensionArchives')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectExtensionArchivesDescription')}
                </div>
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      {pendingDelete &&
        createPortal(
          <Modal
            onClose={() => {
              if (!deletingExtensionId) setPendingDelete(null);
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('extensionDelete')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('extensionDeleteConfirm').replace('{name}', pendingDelete.name)}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deletingExtensionId !== null}
                className="rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={deletingExtensionId !== null}
                className="rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deletingExtensionId ? i18nService.t('extensionDeleting') : i18nService.t('delete')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
};

export default ExtensionsManager;
