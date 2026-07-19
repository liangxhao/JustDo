import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  FolderIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { PluginKind } from '@shared/plugins/marketplace';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { groupHooksBySource, HookGroupId } from '@/features/plugins/components/hooks/hookGroups';
import MarketplaceView from '@/features/plugins/components/marketplace/MarketplaceView';
import { hookService } from '@/features/plugins/services/hookService';
import { HookEntry } from '@/features/plugins/types/hook';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

type HookTab = 'installed' | 'marketplace';

const getMissingSummary = (hook: HookEntry): string => {
  const missing = hook.missing;
  const parts = [
    missing.bins.length > 0
      ? `${i18nService.t('hookMissingBins')}: ${missing.bins.join(', ')}`
      : '',
    (missing.anyBins ?? []).length > 0
      ? `${i18nService.t('hookMissingAnyBins')}: ${(missing.anyBins ?? []).join(', ')}`
      : '',
    missing.env.length > 0 ? `${i18nService.t('hookMissingEnv')}: ${missing.env.join(', ')}` : '',
    missing.config.length > 0
      ? `${i18nService.t('hookMissingConfig')}: ${missing.config.join(', ')}`
      : '',
    missing.os.length > 0 ? `${i18nService.t('hookMissingOs')}: ${missing.os.join(', ')}` : '',
  ].filter(Boolean);
  return parts.join('; ');
};

const HookManager: React.FC = () => {
  const [activeTab, setActiveTab] = useState<HookTab>('installed');
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [managedHooksDir, setManagedHooksDir] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState('');
  const [gatewayOffline, setGatewayOffline] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingHookIds, setUpdatingHookIds] = useState<Set<string>>(() => new Set());
  const [selectedHook, setSelectedHook] = useState<HookEntry | null>(null);
  const [restartNotice, setRestartNotice] = useState(false);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState('');
  const [importErrors, setImportErrors] = useState<{ fileName: string; error: string }[]>([]);
  const [hookPendingDelete, setHookPendingDelete] = useState<HookEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState('');

  useEffect(() => {
    let isActive = true;
    const loadHooks = async () => {
      setIsLoading(true);
      const result = await hookService.loadHooks();
      if (!isActive) return;
      setHooks(result.hooks ?? []);
      setWorkspaceDir(result.workspaceDir ?? '');
      setManagedHooksDir(result.managedHooksDir ?? '');
      setGatewayOffline(hookService.isGatewayOffline());
      setActionError(result.success ? '' : result.error || i18nService.t('hookLoadFailed'));
      setIsLoading(false);
    };
    loadHooks();
    return () => {
      isActive = false;
    };
  }, []);

  const filteredHooks = useMemo(() => {
    const query = searchQuery.toLowerCase();
    if (!query) return hooks;
    return hooks.filter(
      hook =>
        hook.name.toLowerCase().includes(query) ||
        hook.description.toLowerCase().includes(query) ||
        hook.events.join(' ').toLowerCase().includes(query) ||
        hook.source.toLowerCase().includes(query),
    );
  }, [hooks, searchQuery]);

  const groupedHooks = useMemo(() => groupHooksBySource(filteredHooks), [filteredHooks]);

  const getGroupLabel = (groupId: HookGroupId) => i18nService.t(`hookGroup.${groupId}.label`);

  const getGroupDescription = (groupId: HookGroupId) =>
    i18nService.t(`hookGroup.${groupId}.description`);

  const setHookUpdating = (hookId: string, updating: boolean) => {
    setUpdatingHookIds(current => {
      const next = new Set(current);
      if (updating) {
        next.add(hookId);
      } else {
        next.delete(hookId);
      }
      return next;
    });
  };

  const handleToggleHook = async (hook: HookEntry) => {
    if (hook.managedByPlugin) {
      setActionError(i18nService.t('hookManagedByPlugin'));
      return;
    }
    if (!hook.enabled && !hook.requirementsSatisfied) {
      setActionError(i18nService.t('hookMissingRequirements'));
      return;
    }

    setActionError('');
    setHookUpdating(hook.id, true);
    try {
      const result = await hookService.setHookEnabled(hook.id, !hook.enabled);
      setHooks(result.hooks ?? hookService.getHooks());
      setWorkspaceDir(result.workspaceDir ?? workspaceDir);
      setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
      setRestartNotice(Boolean(result.restartRequired));
      setSelectedHook(current =>
        current?.id === hook.id
          ? ((result.hooks ?? hookService.getHooks()).find(item => item.id === hook.id) ?? current)
          : current,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('hookUpdateFailed'));
    } finally {
      setHookUpdating(hook.id, false);
    }
  };

  const handleOpenFolder = async (hook: HookEntry) => {
    const targetPath = hook.baseDir || managedHooksDir || workspaceDir;
    await window.electron.shell.openPath(targetPath);
  };

  const handleImportHooks = async (sourceType: 'folders' | 'archives') => {
    if (importing) return;
    try {
      setImportPickerOpen(false);
      setImporting(true);
      setActionError('');
      setImportSuccess('');
      setImportErrors([]);

      const selection =
        sourceType === 'folders'
          ? await window.electron.dialog.selectFolders({
              title: i18nService.t('selectHookFolders'),
            })
          : await window.electron.dialog.selectFiles({
              title: i18nService.t('selectHookArchives'),
              filters: [
                {
                  name: i18nService.t('hookArchiveFiles'),
                  extensions: ['zip', 'tar', 'gz', 'tgz'],
                },
              ],
            });
      if (!selection.success || !selection.paths?.length) return;

      const results = [];
      for (const sourcePath of selection.paths) {
        const result = await hookService.importHook(sourcePath);
        results.push({ sourcePath, ...result });
        if (result.success) {
          setHooks(result.hooks ?? hookService.getHooks());
          setWorkspaceDir(result.workspaceDir ?? workspaceDir);
          setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
        }
      }

      const importedIds = results
        .filter(result => result.success)
        .map(result => result.hookId)
        .filter((id): id is string => Boolean(id));
      if (importedIds.length > 0) {
        setImportSuccess(importedIds.join(', '));
        setTimeout(() => setImportSuccess(''), 5000);
      }
      setImportErrors(
        results
          .filter(result => !result.success)
          .map(result => ({
            fileName: result.sourcePath.split(/[/\\]/).pop() || result.sourcePath,
            error: result.error || i18nService.t('hookImportFailed'),
          })),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('hookImportFailed'));
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteClick = (hook: HookEntry) => {
    setSelectedHook(null);
    setHookPendingDelete(hook);
  };

  const handleConfirmDelete = async () => {
    if (!hookPendingDelete || deleting) return;
    setDeleting(true);
    setActionError('');
    try {
      const result = await hookService.deleteHook(hookPendingDelete.id);
      setHooks(result.hooks ?? hookService.getHooks());
      setWorkspaceDir(result.workspaceDir ?? workspaceDir);
      setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
      setRestartNotice(Boolean(result.restartRequired));
      setDeleteSuccess(hookPendingDelete.name);
      setHookPendingDelete(null);
      setTimeout(() => setDeleteSuccess(''), 5000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('hookDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  const tabClass = (tab: HookTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative ${
      activeTab === tab ? 'text-foreground' : 'text-secondary hover:hover:text-foreground'
    }`;

  const tabIndicatorClass = (tab: HookTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-primary' : 'bg-transparent'
    }`;

  const renderToggle = (hook: HookEntry) => {
    const disabled = gatewayOffline || updatingHookIds.has(hook.id) || hook.managedByPlugin;
    return (
      <div
        className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        } ${hook.enabled ? 'bg-primary' : 'bg-border'}`}
        onClick={event => {
          event.stopPropagation();
          if (!disabled) void handleToggleHook(hook);
        }}
      >
        <div
          className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
            hook.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
          }`}
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {gatewayOffline && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
          {i18nService.t('gatewayOfflineHooksUnavailable')}
        </div>
      )}

      {actionError && <ErrorMessage message={actionError} onClose={() => setActionError('')} />}

      {importErrors.length > 0 && (
        <div className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          <div className="flex items-center justify-between">
            <span className="font-medium">{i18nService.t('hookImportFailed')}</span>
            <button
              type="button"
              onClick={() => setImportErrors([])}
              className="rounded p-1 transition-colors hover:bg-red-500/20"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <ul className="list-inside list-disc space-y-1 text-xs">
            {importErrors.map(error => (
              <li key={error.fileName}>
                <span className="font-medium">{error.fileName}:</span> {error.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {importSuccess && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-600">
          {i18nService.t('hookImportSuccess').replace('{hookId}', importSuccess)}
        </div>
      )}

      {deleteSuccess && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-600">
          {i18nService.t('hookDeleteSuccess').replace('{name}', deleteSuccess)}
        </div>
      )}

      {restartNotice && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-300">
          <span>{i18nService.t('hookRestartRequired')}</span>
          <button
            type="button"
            onClick={() => setRestartNotice(false)}
            className="rounded-lg px-2 py-1 text-xs transition-colors hover:bg-yellow-500/10"
          >
            {i18nService.t('dismiss')}
          </button>
        </div>
      )}

      <div className="sticky top-0 z-10 bg-background pb-4 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setActiveTab('installed')}
              className={tabClass('installed')}
            >
              {i18nService.t('hookInstalled')}
              {hooks.length > 0 && (
                <span className="ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px]">
                  {hooks.length}
                </span>
              )}
              <div className={tabIndicatorClass('installed')} />
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('marketplace')}
              className={tabClass('marketplace')}
            >
              {i18nService.t('hookMarketplace')}
              <div className={tabIndicatorClass('marketplace')} />
            </button>
          </div>
          <p className="min-w-0 truncate pb-2 text-right text-sm text-secondary">
            {i18nService.t('hooksDescription')}
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
                placeholder={i18nService.t('searchHooks')}
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                disabled={gatewayOffline}
                className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            {!gatewayOffline && (
              <Tooltip
                className="w-full sm:ml-auto sm:w-auto"
                content={i18nService.t('importHookTooltip')}
                position="bottom"
              >
                <button
                  type="button"
                  onClick={() => setImportPickerOpen(true)}
                  disabled={importing}
                  className={`flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised hover:text-foreground sm:w-auto ${
                    importing ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  <ArrowUpTrayIcon className="h-4 w-4" />
                  {importing ? i18nService.t('importHookProgress') : i18nService.t('importHook')}
                </button>
              </Tooltip>
            )}
          </div>
          {isLoading ? (
            <div className="py-8 text-center text-sm text-secondary">
              {i18nService.t('loading')}
            </div>
          ) : filteredHooks.length === 0 ? (
            <div className="py-8 text-center text-sm text-secondary">
              {gatewayOffline ? i18nService.t('gatewayOffline') : i18nService.t('noHooksAvailable')}
            </div>
          ) : (
            <div className="space-y-6">
              {groupedHooks.map(group => (
                <section key={group.id}>
                  <div className="mb-2.5 flex min-w-0 items-center gap-2">
                    <h3 className="shrink-0 text-sm font-semibold text-foreground">
                      {getGroupLabel(group.id)}
                    </h3>
                    <span className="shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                      {group.hooks.length}
                    </span>
                    <p className="min-w-0 truncate text-xs text-secondary">
                      {getGroupDescription(group.id)}
                    </p>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(17rem,100%),1fr))] items-start gap-3">
                    {group.hooks.map(hook => {
                      const missingSummary = getMissingSummary(hook);
                      return (
                        <div
                          key={`${group.id}:${hook.id}`}
                          className="cursor-pointer rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary"
                          onClick={() => setSelectedHook(hook)}
                        >
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-background text-sm">
                                {hook.emoji || <ConnectorIcon className="h-4 w-4 text-secondary" />}
                              </div>
                              <span className="truncate text-sm font-medium text-foreground">
                                {hook.name}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {hook.source === 'openclaw-managed' && !hook.managedByPlugin && (
                                <button
                                  type="button"
                                  title={i18nService.t('deleteHook')}
                                  onClick={event => {
                                    event.stopPropagation();
                                    handleDeleteClick(hook);
                                  }}
                                  className="rounded-lg p-1 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500"
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              )}
                              {renderToggle(hook)}
                            </div>
                          </div>
                          <Tooltip content={hook.description} position="bottom" maxWidth="360px">
                            <p className="line-clamp-2 text-xs text-secondary">
                              {hook.description}
                            </p>
                          </Tooltip>
                          <div className="mt-3 flex flex-wrap items-center gap-1.5">
                            {hook.events.slice(0, 2).map(event => (
                              <span
                                key={event}
                                className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary"
                              >
                                {event}
                              </span>
                            ))}
                            {hook.events.length > 2 && (
                              <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                                +{hook.events.length - 2}
                              </span>
                            )}
                            {missingSummary && (
                              <Tooltip content={missingSummary} position="bottom" maxWidth="360px">
                                <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">
                                  {i18nService.t('hookStatusMissing')}
                                </span>
                              </Tooltip>
                            )}
                          </div>
                        </div>
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
          kind={PluginKind.HOOK}
          icon={<ConnectorIcon className="h-4 w-4" />}
          installed={hooks.map(hook => ({ id: hook.id }))}
          onInstalled={async () => {
            const result = await hookService.loadHooks();
            setHooks(result.hooks ?? []);
          }}
        />
      )}

      {selectedHook &&
        createPortal(
          <Modal
            onClose={() => setSelectedHook(null)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-lg mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-6"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-background text-lg">
                  {selectedHook.emoji || <ConnectorIcon className="h-5 w-5 text-secondary" />}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-foreground">
                    {selectedHook.name}
                  </div>
                  {!selectedHook.requirementsSatisfied && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">
                        {i18nService.t('hookStatusMissing')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHook(null)}
                className="flex-shrink-0 rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="mb-4 text-sm text-secondary">{selectedHook.description}</p>

            <div className="mb-5 space-y-3">
              <div>
                <div className="mb-1 text-xs font-medium text-foreground">
                  {i18nService.t('hookEvents')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedHook.events.length > 0 ? (
                    selectedHook.events.map(event => (
                      <span
                        key={event}
                        className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary"
                      >
                        {event}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-secondary">{i18nService.t('none')}</span>
                  )}
                </div>
              </div>

              {(getMissingSummary(selectedHook) || selectedHook.blockedReason) && (
                <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3">
                  <div className="mb-1 text-xs font-medium text-yellow-700 dark:text-yellow-300">
                    {i18nService.t('hookMissingRequirements')}
                  </div>
                  {selectedHook.blockedReason && (
                    <p className="text-xs text-secondary">{selectedHook.blockedReason}</p>
                  )}
                  {getMissingSummary(selectedHook) && (
                    <p className="mt-1 break-words font-mono text-xs text-secondary">
                      {getMissingSummary(selectedHook)}
                    </p>
                  )}
                </div>
              )}

              {selectedHook.managedByPlugin && (
                <div className="rounded-xl border border-border bg-background p-3 text-xs text-secondary">
                  {i18nService.t('hookManagedByPlugin')}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => handleOpenFolder(selectedHook)}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <FolderIcon className="h-3.5 w-3.5" />
              {i18nService.t('openFolder')}
            </button>
          </Modal>,
          document.body,
        )}

      {importPickerOpen &&
        createPortal(
          <Modal
            onClose={() => setImportPickerOpen(false)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-md mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('importHook')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('selectHookSourceDescription')}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleImportHooks('folders')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <FolderIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectHookFolders')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectHookFoldersDescription')}
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleImportHooks('archives')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <ArchiveBoxIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectHookArchives')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectHookArchivesDescription')}
                </div>
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      {hookPendingDelete &&
        createPortal(
          <Modal
            onClose={() => !deleting && setHookPendingDelete(null)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('deleteHook')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('hookDeleteConfirm').replace('{name}', hookPendingDelete.name)}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setHookPendingDelete(null)}
                disabled={deleting}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={deleting}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? i18nService.t('hookDeleting') : i18nService.t('delete')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
};

export default HookManager;
