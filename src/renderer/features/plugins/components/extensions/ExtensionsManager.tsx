import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  QuestionMarkCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  ExtensionImportProgress,
  ExtensionImportStage,
  InstalledOpenClawExtension,
  OpenClawPluginCapabilityReview,
} from '@shared/openclaw/extensions';
import { PluginKind } from '@shared/plugins/marketplace';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  ExtensionGroupId,
  groupExtensionsByOwnership,
} from '@/features/plugins/components/extensions/extensionGroups';
import MarketplaceView from '@/features/plugins/components/marketplace/MarketplaceView';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import OperationResultModal, {
  type OperationResult,
} from '@/shared/components/common/OperationResultModal';
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

type ExtensionToggleProps = {
  extension: InstalledOpenClawExtension;
  canToggle: boolean;
  pending: boolean;
  busy: boolean;
  onToggle: () => void;
};

const ExtensionToggle: React.FC<ExtensionToggleProps> = ({
  extension,
  canToggle,
  pending,
  busy,
  onToggle,
}) => {
  const displayedEnabled = pending ? !extension.enabled : extension.enabled;
  const label = !canToggle
    ? i18nService.t('extensionToggleUnavailable')
    : pending
      ? `${i18nService.t(
          displayedEnabled ? 'extensionEnable' : 'extensionDisable',
        )} · ${i18nService.t('extensionImportStageRestartingGateway')}`
      : i18nService.t(extension.enabled ? 'extensionDisable' : 'extensionEnable');

  return (
    <Tooltip content={label} position="bottom">
      <button
        type="button"
        role="switch"
        aria-checked={displayedEnabled}
        aria-busy={pending || undefined}
        aria-label={label}
        onClick={event => {
          event.stopPropagation();
          onToggle();
        }}
        disabled={busy || !canToggle}
        className={`relative flex h-5 w-9 items-center overflow-hidden rounded-full transition-[background-color,box-shadow,opacity] duration-300 ease-smooth ${
          displayedEnabled ? 'bg-primary' : 'bg-border'
        } ${
          pending
            ? 'cursor-wait ring-2 ring-primary/25'
            : busy || !canToggle
              ? 'cursor-not-allowed opacity-50'
              : ''
        }`}
      >
        {pending && (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 animate-pulse rounded-full bg-white/10"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/45 to-transparent"
            />
          </>
        )}
        <span
          className={`relative z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white transition-[transform,box-shadow] duration-300 ease-smooth ${
            displayedEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
          } ${pending ? 'shadow-lg' : 'shadow-md'}`}
        >
          {pending && (
            <span
              aria-hidden="true"
              className="h-2 w-2 animate-spin rounded-full border border-primary/25 border-t-primary"
            />
          )}
        </span>
      </button>
    </Tooltip>
  );
};

const ExtensionsManager: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ExtensionTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [actionOutcome, setActionOutcome] = useState<OperationResult | null>(null);
  const [extensions, setExtensions] = useState<InstalledOpenClawExtension[]>([]);
  const [loadingExtensions, setLoadingExtensions] = useState(true);
  const [importProgress, setImportProgress] = useState<ExtensionImportProgress | null>(null);
  const [importElapsedSeconds, setImportElapsedSeconds] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<InstalledOpenClawExtension | null>(null);
  const [deletingExtensionId, setDeletingExtensionId] = useState<string | null>(null);
  const [togglingExtensionId, setTogglingExtensionId] = useState<string | null>(null);
  const [pendingCapabilityReview, setPendingCapabilityReview] = useState<
    | {
        kind: 'toggle';
        extension: InstalledOpenClawExtension;
        review: OpenClawPluginCapabilityReview;
      }
    | {
        kind: 'import';
        requestId: string;
        sourcePath: string;
        displayName: string;
        review: OpenClawPluginCapabilityReview;
        remainingSourcePaths: string[];
        completedLabels: string[];
        failures: Array<{ label: string; message: string }>;
      }
    | null
  >(null);
  const [selectedExtension, setSelectedExtension] = useState<InstalledOpenClawExtension | null>(
    null,
  );
  const [configurationValues, setConfigurationValues] = useState<Record<string, string>>({});
  const [configurationError, setConfigurationError] = useState('');
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const extensionActionBusy =
    importing ||
    deletingExtensionId !== null ||
    togglingExtensionId !== null ||
    savingConfiguration;

  const loadExtensions = useCallback(async () => {
    try {
      const result = await window.electron.extensions.list();
      if (!result.success) throw new Error(result.error || i18nService.t('extensionListFailed'));
      setExtensions(result.extensions);
      return result.extensions;
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('extensionListFailed'),
        message: error instanceof Error ? error.message : i18nService.t('extensionListFailed'),
      });
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
  const groupedExtensions = useMemo(
    () => groupExtensionsByOwnership(filteredExtensions),
    [filteredExtensions],
  );

  const handleImportExtensions = async (sourceType: 'folders' | 'archives') => {
    if (extensionActionBusy) return;

    try {
      setImportPickerOpen(false);
      setImporting(true);
      setActionOutcome(null);
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
        if (importResult.capabilityReview) {
          const completedLabels = results
            .filter(item => item.success)
            .map(
              item => item.extensionId || item.sourcePath.split(/[/\\]/).pop() || item.sourcePath,
            );
          const failures = results
            .filter(item => !item.success)
            .map(item => ({
              label: item.sourcePath.split(/[/\\]/).pop() || item.sourcePath,
              message: item.error || i18nService.t('extensionImportFailed'),
            }));
          setPendingCapabilityReview({
            kind: 'import',
            requestId,
            sourcePath,
            displayName: sourcePath.split(/[/\\]/).pop() || sourcePath,
            review: importResult.capabilityReview,
            remainingSourcePaths: result.paths.slice(index + 1),
            completedLabels,
            failures,
          });
          await loadExtensions();
          return;
        }
        results.push({ sourcePath, ...importResult });
      }

      const succeeded = results.filter(item => item.success);
      const failed = results.filter(item => !item.success);
      // Reconcile with disk even when a later installer step reports failure. OpenClaw
      // may have already published the extension before its CLI or Gateway restart fails.
      await loadExtensions();
      if (succeeded.length > 0 && failed.length === 0) {
        const labels = succeeded
          .map(item => item.extensionId || item.sourcePath.split(/[/\\]/).pop())
          .filter(Boolean)
          .join(', ');
        setActionOutcome({
          type: 'success',
          title: i18nService.t('importExtension'),
          message: i18nService.t('extensionImportSuccess').replace('{extensionId}', labels),
        });
      }
      if (failed.length > 0) {
        const partial = succeeded.length > 0;
        setActionOutcome({
          type: 'error',
          title: i18nService.t(partial ? 'pluginImportPartialTitle' : 'extensionImportFailed'),
          ...(partial
            ? {
                message: i18nService
                  .t('pluginImportPartialSummary')
                  .replace('{successCount}', String(succeeded.length))
                  .replace('{failureCount}', String(failed.length)),
              }
            : {}),
          items: [
            ...succeeded.map(item => ({
              label: item.extensionId || item.sourcePath.split(/[/\\]/).pop() || item.sourcePath,
              message: i18nService.t('pluginImportItemSuccess'),
              type: 'success' as const,
            })),
            ...failed.map(item => {
              const fileName = item.sourcePath.split(/[/\\]/).pop() || item.sourcePath;
              const error = item.failedStage
                ? i18nService
                    .t('extensionImportFailedAtStage')
                    .replace('{stage}', getImportStageLabel(item.failedStage))
                    .replace('{error}', item.error || i18nService.t('extensionImportFailed'))
                : item.error || i18nService.t('extensionImportFailed');
              return { label: fileName, message: error, type: 'error' as const };
            }),
          ],
        });
      }
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('extensionImportFailed'),
        message: error instanceof Error ? error.message : i18nService.t('extensionImportFailed'),
      });
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
      setActionOutcome(null);
      const result = await window.electron.extensions.delete({ extensionId: extension.id });
      if (!result.success) {
        throw new Error(result.error || i18nService.t('extensionDeleteFailed'));
      }
      setPendingDelete(null);
      setActionOutcome({
        type: 'success',
        title: i18nService.t('extensionDelete'),
        message: [
          i18nService.t('extensionDeleteSuccess').replace('{name}', extension.name),
          ...(result.warnings ?? []),
        ].join('\n'),
      });
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('extensionDeleteFailed'),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const latestExtensions = await loadExtensions();
      if (latestExtensions && !latestExtensions.some(item => item.id === extension.id)) {
        setPendingDelete(null);
      }
      setDeletingExtensionId(null);
    }
  };

  const handleToggleExtension = async (
    extension: InstalledOpenClawExtension,
    reviewToken?: string,
  ) => {
    if (extensionActionBusy) return;
    try {
      setTogglingExtensionId(extension.id);
      setActionOutcome(null);
      const result = await window.electron.extensions.setEnabled({
        extensionId: extension.id,
        enabled: !extension.enabled,
        reviewToken,
      });
      if (result.capabilityReview) {
        setPendingCapabilityReview({ kind: 'toggle', extension, review: result.capabilityReview });
        return;
      }
      if (!result.success) {
        throw new Error(result.error || i18nService.t('extensionStatusUpdateFailed'));
      }
      if (result.warnings?.length) {
        setActionOutcome({
          type: 'success',
          title: i18nService.t('extensionStatusUpdatedWithWarnings'),
          message: result.warnings.join('\n'),
        });
      }
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('extensionStatusUpdateFailed'),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await loadExtensions();
      setTogglingExtensionId(null);
    }
  };

  const handleConfirmImportCapability = async (
    pending: Extract<NonNullable<typeof pendingCapabilityReview>, { kind: 'import' }>,
  ) => {
    if (extensionActionBusy) return;
    try {
      setPendingCapabilityReview(null);
      setImporting(true);
      setActionOutcome(null);
      setImportProgress(null);
      setImportElapsedSeconds(0);
      const result = await window.electron.extensions.importPath({
        requestId: pending.requestId,
        sourcePath: pending.sourcePath,
        reviewToken: pending.review.reviewToken,
      });
      if (result.capabilityReview) {
        setPendingCapabilityReview({ ...pending, review: result.capabilityReview });
        return;
      }
      const completedLabels = [...pending.completedLabels];
      const failures = [...pending.failures];
      if (result.success) {
        completedLabels.push(result.extensionId || pending.displayName);
      } else {
        failures.push({
          label: pending.displayName,
          message: result.error || i18nService.t('extensionImportFailed'),
        });
      }
      for (const [index, sourcePath] of pending.remainingSourcePaths.entries()) {
        const requestId = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
        const nextResult = await window.electron.extensions.importPath({ requestId, sourcePath });
        if (nextResult.capabilityReview) {
          setPendingCapabilityReview({
            kind: 'import',
            requestId,
            sourcePath,
            displayName: sourcePath.split(/[/\\]/).pop() || sourcePath,
            review: nextResult.capabilityReview,
            remainingSourcePaths: pending.remainingSourcePaths.slice(index + 1),
            completedLabels,
            failures,
          });
          await loadExtensions();
          return;
        }
        const label = nextResult.extensionId || sourcePath.split(/[/\\]/).pop() || sourcePath;
        if (nextResult.success) {
          completedLabels.push(label);
        } else {
          failures.push({
            label,
            message: nextResult.error || i18nService.t('extensionImportFailed'),
          });
        }
      }
      await loadExtensions();
      if (failures.length === 0) {
        setActionOutcome({
          type: 'success',
          title: i18nService.t('importExtension'),
          message: i18nService
            .t('extensionImportSuccess')
            .replace('{extensionId}', completedLabels.join(', ')),
        });
      } else {
        setActionOutcome({
          type: 'error',
          title: i18nService.t(
            completedLabels.length > 0 ? 'pluginImportPartialTitle' : 'extensionImportFailed',
          ),
          ...(completedLabels.length > 0
            ? {
                message: i18nService
                  .t('pluginImportPartialSummary')
                  .replace('{successCount}', String(completedLabels.length))
                  .replace('{failureCount}', String(failures.length)),
              }
            : {}),
          items: [
            ...completedLabels.map(label => ({
              label,
              message: i18nService.t('pluginImportItemSuccess'),
              type: 'success' as const,
            })),
            ...failures.map(item => ({ ...item, type: 'error' as const })),
          ],
        });
      }
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('extensionImportFailed'),
        message: error instanceof Error ? error.message : i18nService.t('extensionImportFailed'),
      });
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  const openExtensionDetails = (extension: InstalledOpenClawExtension) => {
    setSelectedExtension(extension);
    setConfigurationValues({});
    setConfigurationError('');
  };

  const handleSaveConfiguration = async () => {
    if (!selectedExtension || extensionActionBusy) return;
    const values = Object.fromEntries(
      Object.entries(configurationValues).filter(([, value]) => value.trim()),
    );
    if (Object.keys(values).length === 0) {
      setConfigurationError(i18nService.t('extensionConfigurationValueRequired'));
      return;
    }
    try {
      setSavingConfiguration(true);
      setConfigurationError('');
      const result = await window.electron.extensions.updateConfiguration({
        extensionId: selectedExtension.id,
        values,
      });
      if (!result.success) {
        throw new Error(result.error || i18nService.t('extensionConfigurationSaveFailed'));
      }
      const latestExtensions = await loadExtensions();
      const updatedExtension = latestExtensions?.find(item => item.id === selectedExtension.id);
      if (updatedExtension) setSelectedExtension(updatedExtension);
      setConfigurationValues({});
    } catch (error) {
      setConfigurationError(
        error instanceof Error ? error.message : i18nService.t('extensionConfigurationSaveFailed'),
      );
    } finally {
      setSavingConfiguration(false);
    }
  };

  const handleOpenExtensionFolder = async (extension: InstalledOpenClawExtension) => {
    if (!extension.installPath) return;
    setConfigurationError('');
    const result = await window.electron.shell.openPath(extension.installPath);
    if (!result.success) {
      const error = result.error || i18nService.t('extensionOpenFolderFailed');
      if (selectedExtension?.id === extension.id) {
        setConfigurationError(error);
      } else {
        setActionOutcome({
          type: 'error',
          title: i18nService.t('extensionOpenFolderFailed'),
          message: error,
        });
      }
    }
  };

  const getExtensionGroupLabel = (groupId: ExtensionGroupId): string =>
    i18nService.t(`extensionGroup.${groupId}.label`);

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
            <div className="space-y-6">
              {groupedExtensions.map(group => (
                <section key={group.id}>
                  <div className="mb-2.5 flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {getExtensionGroupLabel(group.id)}
                    </h3>
                    <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                      {group.extensions.length}
                    </span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] items-stretch gap-3">
                    {group.extensions.map(extension => {
                      const canToggle = extension.canToggle === true;
                      const canOpenFolder = Boolean(extension.installPath);
                      const canDelete = extension.removable === true;
                      return (
                        <article
                          key={extension.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => openExtensionDetails(extension)}
                          onKeyDown={event => {
                            if (
                              event.target === event.currentTarget &&
                              (event.key === 'Enter' || event.key === ' ')
                            ) {
                              event.preventDefault();
                              openExtensionDetails(extension);
                            }
                          }}
                          className="relative flex min-h-28 h-full cursor-pointer flex-col rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface">
                                <PuzzleIcon className="h-4 w-4 text-secondary" />
                              </div>
                              <h3 className="truncate text-sm font-medium text-foreground">
                                {extension.name}
                              </h3>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <ExtensionToggle
                                extension={extension}
                                canToggle={canToggle}
                                pending={togglingExtensionId === extension.id}
                                busy={extensionActionBusy}
                                onToggle={() => void handleToggleExtension(extension)}
                              />
                              <Tooltip
                                content={i18nService.t(
                                  canOpenFolder ? 'openFolder' : 'extensionFolderUnavailable',
                                )}
                                position="bottom"
                              >
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation();
                                    void handleOpenExtensionFolder(extension);
                                  }}
                                  disabled={extensionActionBusy || !canOpenFolder}
                                  className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                                  aria-label={i18nService.t(
                                    canOpenFolder ? 'openFolder' : 'extensionFolderUnavailable',
                                  )}
                                >
                                  <FolderIcon className="h-4 w-4" />
                                </button>
                              </Tooltip>
                              <Tooltip
                                content={i18nService.t(
                                  canDelete ? 'extensionDelete' : 'extensionDeleteUnavailable',
                                )}
                                position="bottom"
                              >
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation();
                                    setPendingDelete(extension);
                                  }}
                                  disabled={extensionActionBusy || !canDelete}
                                  className="rounded-lg p-1 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                                  aria-label={i18nService.t(
                                    canDelete ? 'extensionDelete' : 'extensionDeleteUnavailable',
                                  )}
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              </Tooltip>
                            </div>
                          </div>

                          <div className="min-h-10">
                            {extension.description && (
                              <Tooltip
                                content={extension.description}
                                position="bottom"
                                maxWidth="360px"
                                className="block w-full"
                              >
                                <p className="line-clamp-2 text-xs leading-5 text-secondary">
                                  {extension.description}
                                </p>
                              </Tooltip>
                            )}
                          </div>

                          {extension.missingRequirements.length > 0 && (
                            <div className="absolute bottom-2 right-2">
                              <Tooltip
                                content={i18nService.t('extensionMissingConfiguration')}
                                position="top"
                              >
                                <ExclamationTriangleIcon
                                  className="h-4 w-4 text-amber-600 dark:text-amber-400"
                                  aria-label={i18nService.t('extensionMissingConfiguration')}
                                />
                              </Tooltip>
                            </div>
                          )}
                          {extension.error && (
                            <Tooltip content={extension.error} position="bottom" maxWidth="360px">
                              <ExclamationTriangleIcon
                                className="absolute bottom-2 right-2 h-4 w-4 text-red-500"
                                aria-label={extension.error}
                              />
                            </Tooltip>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'marketplace' && (
        <MarketplaceView
          kind={PluginKind.EXTENSION}
          icon={<PuzzleIcon className="h-4 w-4" />}
          installed={extensions.map(extension => ({
            id: extension.id,
            version: extension.version,
          }))}
          onInstalled={async () => {
            await loadExtensions();
          }}
        />
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

      {selectedExtension &&
        createPortal(
          <Modal
            onClose={() => {
              if (!savingConfiguration) setSelectedExtension(null);
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background">
                  <PuzzleIcon className="h-5 w-5 text-secondary" />
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">
                    {selectedExtension.name}
                  </h2>
                  {selectedExtension.version && (
                    <span className="shrink-0 text-xs text-secondary">
                      v{selectedExtension.version}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedExtension(null)}
                disabled={savingConfiguration}
                className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                aria-label={i18nService.t('close')}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {selectedExtension.description && (
              <p className="mt-3 text-sm leading-5 text-secondary">
                {selectedExtension.description}
              </p>
            )}

            <div className="mt-5">
              {selectedExtension.configurationFields.length > 0 && (
                <div className="space-y-4">
                  {selectedExtension.configurationFields.map(field => (
                    <div
                      key={field.path}
                      className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] items-center gap-3"
                    >
                      <div className="flex min-w-0 items-center justify-end text-right text-xs font-medium text-foreground">
                        <label
                          htmlFor={`extension-config-${field.path}`}
                          className="truncate"
                          title={field.requirement || field.label}
                        >
                          {field.requirement || field.label}
                        </label>
                        {field.requirement && (
                          <span className="ml-0.5 text-base font-semibold leading-none text-red-500">
                            *
                          </span>
                        )}
                        {field.help && (
                          <Tooltip
                            content={field.help}
                            position="bottom"
                            maxWidth="320px"
                            className="ml-1 shrink-0"
                          >
                            <QuestionMarkCircleIcon className="h-3.5 w-3.5 text-secondary" />
                          </Tooltip>
                        )}
                      </div>
                      <input
                        id={`extension-config-${field.path}`}
                        type={field.sensitive ? 'password' : 'text'}
                        value={configurationValues[field.path] || ''}
                        onChange={event =>
                          setConfigurationValues(current => ({
                            ...current,
                            [field.path]: event.target.value,
                          }))
                        }
                        disabled={savingConfiguration}
                        required={Boolean(field.requirement)}
                        autoComplete="new-password"
                        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                      />
                    </div>
                  ))}
                </div>
              )}

              {configurationError && (
                <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
                  {configurationError}
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              {selectedExtension.installPath ? (
                <button
                  type="button"
                  onClick={() => void handleOpenExtensionFolder(selectedExtension)}
                  disabled={savingConfiguration}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                >
                  <FolderIcon className="h-4 w-4" />
                  {i18nService.t('openFolder')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedExtension(null)}
                  disabled={savingConfiguration}
                  className="rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {i18nService.t('cancel')}
                </button>
                {selectedExtension.configurationFields.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleSaveConfiguration()}
                    disabled={savingConfiguration}
                    className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {i18nService.t(savingConfiguration ? 'saving' : 'save')}
                  </button>
                )}
              </div>
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

      {pendingCapabilityReview &&
        createPortal(
          <Modal
            onClose={() => setPendingCapabilityReview(null)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />
              {i18nService.t('extensionCapabilityReviewTitle')}
            </div>
            <p className="mt-2 text-sm leading-5 text-secondary">
              {i18nService
                .t('extensionCapabilityReviewDescription')
                .replace(
                  '{name}',
                  pendingCapabilityReview.kind === 'toggle'
                    ? pendingCapabilityReview.extension.name
                    : pendingCapabilityReview.displayName,
                )}
            </p>
            {pendingCapabilityReview.review.source && (
              <div className="mt-4 rounded-xl border border-border bg-background p-3 text-xs">
                <div className="font-semibold text-foreground">
                  {i18nService.t('extensionCapabilitySource')}
                </div>
                <div className="mt-1 break-all text-secondary">
                  {[
                    pendingCapabilityReview.review.source.kind,
                    pendingCapabilityReview.review.source.spec ||
                      pendingCapabilityReview.review.source.packageName,
                  ]
                    .filter(Boolean)
                    .join(': ')}
                </div>
                {pendingCapabilityReview.review.source.integrity && (
                  <div className="mt-2 break-all text-secondary">
                    {i18nService.t('extensionCapabilityIntegrity')}:{' '}
                    <code>{pendingCapabilityReview.review.source.integrity}</code>
                  </div>
                )}
              </div>
            )}
            {Object.values(pendingCapabilityReview.review.widened ?? {}).flat().length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  {i18nService.t('extensionCapabilityWidened')}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.values(pendingCapabilityReview.review.widened ?? {})
                    .flat()
                    .map((item, index) => (
                      <code
                        key={`${item}:${index}`}
                        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-foreground"
                      >
                        {item}
                      </code>
                    ))}
                </div>
              </div>
            )}
            <div className="mt-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-secondary">
                {i18nService.t('extensionCapabilityDeclared')}
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-border bg-background p-3">
                <div className="flex flex-wrap gap-1.5">
                  {Object.values(pendingCapabilityReview.review.declared)
                    .flat()
                    .map((item, index) => (
                      <code
                        key={`${item}:${index}`}
                        className="rounded-md bg-surface-raised px-2 py-1 text-xs text-foreground"
                      >
                        {item}
                      </code>
                    ))}
                  {Object.values(pendingCapabilityReview.review.declared).flat().length === 0 && (
                    <span className="text-xs text-secondary">
                      {i18nService.t('extensionCapabilityNone')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-border bg-background p-3 text-xs text-secondary">
              <div className="font-semibold text-foreground">
                {i18nService.t('extensionCapabilityGrants')}
              </div>
              <div className="mt-2 space-y-1 break-all">
                <div>
                  {i18nService.t('extensionCapabilityPromptInjection')}:{' '}
                  {i18nService.t(
                    pendingCapabilityReview.review.grants.hooks.allowPromptInjection.effective
                      ? 'extensionCapabilityAllowed'
                      : 'extensionCapabilityDenied',
                  )}
                </div>
                <div>
                  {i18nService.t('extensionCapabilityConversationAccess')}:{' '}
                  {i18nService.t(
                    pendingCapabilityReview.review.grants.hooks.allowConversationAccess.effective
                      ? 'extensionCapabilityAllowed'
                      : 'extensionCapabilityDenied',
                  )}
                </div>
                {pendingCapabilityReview.review.grants.llm && (
                  <div>LLM: {JSON.stringify(pendingCapabilityReview.review.grants.llm)}</div>
                )}
                {pendingCapabilityReview.review.grants.subagent && (
                  <div>
                    Subagent: {JSON.stringify(pendingCapabilityReview.review.grants.subagent)}
                  </div>
                )}
              </div>
            </div>
            {pendingCapabilityReview.review.trust && (
              <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <div>
                  {i18nService.t('extensionCapabilityTrust')}:{' '}
                  {pendingCapabilityReview.review.trust.disposition}
                </div>
                {pendingCapabilityReview.review.trust.reasons?.length
                  ? pendingCapabilityReview.review.trust.reasons.map(reason => (
                      <div key={reason} className="mt-1">
                        {reason}
                      </div>
                    ))
                  : null}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingCapabilityReview(null)}
                className="rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = pendingCapabilityReview;
                  setPendingCapabilityReview(null);
                  if (pending.kind === 'toggle') {
                    void handleToggleExtension(pending.extension, pending.review.reviewToken);
                  } else {
                    void handleConfirmImportCapability(pending);
                  }
                }}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
              >
                {i18nService.t('extensionCapabilityAccept')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      <OperationResultModal result={actionOutcome} onClose={() => setActionOutcome(null)} />
    </div>
  );
};

export default ExtensionsManager;
