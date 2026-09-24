import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  FolderIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { PluginHubScope } from '@shared/plugins/management';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { HookEntry } from '@/features/plugins/hooks/hook';
import { hookService } from '@/features/plugins/hooks/hookService';
import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginGroupSection from '@/features/plugins/shared/PluginGroupSection';
import type { PluginHubManagerProps } from '@/features/plugins/shared/pluginHubTypes';
import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import PluginStateButton, {
  PluginLockedIndicator,
} from '@/features/plugins/shared/PluginStateButton';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

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

interface HookManagerProps extends PluginHubManagerProps {
  onOpenExtension?: (extensionId: string) => void;
}

const HookManager: React.FC<HookManagerProps> = ({
  searchQuery: sharedSearchQuery,
  visibility = 'all',
  onOpenExtension,
}) => {
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [managedHooksDir, setManagedHooksDir] = useState('');
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const searchQuery = sharedSearchQuery ?? localSearchQuery;
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
    const query = searchQuery.trim().toLowerCase();
    if (!query) return hooks;
    return hooks.filter(
      hook =>
        hook.name.toLowerCase().includes(query) ||
        hook.description.toLowerCase().includes(query) ||
        hook.events.join(' ').toLowerCase().includes(query) ||
        hook.source.toLowerCase().includes(query),
    );
  }, [hooks, searchQuery]);

  const groupedHooks = useMemo(() => {
    const isSystemHook = (hook: HookEntry) =>
      hook.scope === PluginHubScope.SYSTEM ||
      hook.scope === PluginHubScope.EXTENSION ||
      hook.source === 'openclaw-bundled' ||
      hook.managedByPlugin;
    const userHooks = filteredHooks.filter(hook => !isSystemHook(hook));
    const systemHooks = filteredHooks.filter(isSystemHook);
    return [
      ...(userHooks.length > 0 || !searchQuery.trim()
        ? [{ id: 'user' as const, hooks: userHooks }]
        : []),
      ...(systemHooks.length > 0 ? [{ id: 'system' as const, hooks: systemHooks }] : []),
    ];
  }, [filteredHooks, searchQuery]);

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
    const capability = hook.enabled ? hook.management?.disable : hook.management?.enable;
    if (capability && !capability.allowed) {
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
    if (hook.management && !hook.management.remove.allowed) return;
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

  const renderToggle = (hook: HookEntry) => {
    const capability = hook.enabled ? hook.management?.disable : hook.management?.enable;
    if (capability && !capability.allowed && capability.reason === 'managed-by-extension') {
      return <PluginLockedIndicator label={i18nService.t('hookManagedByPlugin')} />;
    }
    const disabled =
      gatewayOffline || updatingHookIds.has(hook.id) || capability?.allowed === false;
    return (
      <PluginStateButton
        checked={hook.enabled}
        label={i18nService.t(hook.enabled ? 'disableHook' : 'enableHook')}
        disabled={disabled}
        busy={updatingHookIds.has(hook.id)}
        onToggle={() => {
          if (!disabled) void handleToggleHook(hook);
        }}
      />
    );
  };
  const importHookAction = !gatewayOffline ? (
    <Tooltip content={i18nService.t('importHookTooltip')} position="bottom">
      <button
        type="button"
        onClick={() => setImportPickerOpen(true)}
        disabled={importing}
        className={`flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground ${
          importing ? 'cursor-not-allowed opacity-50' : ''
        }`}
      >
        <ArrowUpTrayIcon className="h-4 w-4" />
        {importing ? i18nService.t('importHookProgress') : i18nService.t('importHook')}
      </button>
    </Tooltip>
  ) : undefined;

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

      {visibility !== 'available' ? (
        <section className="space-y-4">
          <div className="space-y-4">
            {sharedSearchQuery === undefined && (
              <div className="relative min-w-0 sm:max-w-md">
                <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                <input
                  type="text"
                  placeholder={i18nService.t('searchHooks')}
                  value={searchQuery}
                  onChange={event => setLocalSearchQuery(event.target.value)}
                  disabled={gatewayOffline}
                  className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            )}
            {isLoading ? (
              <div className="py-8 text-center text-sm text-secondary">
                {i18nService.t('loading')}
              </div>
            ) : filteredHooks.length === 0 && searchQuery.trim() ? (
              <div className="py-8 text-center text-sm text-secondary">
                {gatewayOffline
                  ? i18nService.t('gatewayOffline')
                  : i18nService.t('noHooksAvailable')}
              </div>
            ) : (
              <div className="space-y-5">
                {groupedHooks.map(group => (
                  <PluginGroupSection
                    key={group.id}
                    title={i18nService.t(`pluginGroup.${group.id}.label`)}
                    count={group.hooks.length}
                    action={group.id === 'user' ? importHookAction : undefined}
                    collapsible={group.id === 'system'}
                    defaultExpanded={group.id !== 'system'}
                    forceExpanded={Boolean(searchQuery.trim())}
                  >
                    {group.hooks.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-secondary">
                        {i18nService.t('noHooksAvailable')}
                      </p>
                    ) : (
                      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-1 gap-x-4">
                        {group.hooks.map((hook, visualIndex) => {
                          const missingSummary = getMissingSummary(hook);
                          return (
                            <article
                              key={`${group.id}:${hook.id}`}
                              className="group relative min-h-16 min-w-0 cursor-pointer rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-border/70 hover:bg-surface-raised/70"
                              onClick={() => setSelectedHook(hook)}
                            >
                              <button
                                type="button"
                                className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary"
                                aria-label={`${i18nService.t('subtaskShowInfo')}: ${hook.name}`}
                                onClick={event => {
                                  event.stopPropagation();
                                  setSelectedHook(hook);
                                }}
                              />
                              <div className="pointer-events-none relative z-10 flex items-center justify-between gap-2 [&_button]:pointer-events-auto">
                                <div className="flex min-w-0 items-center gap-2">
                                  <div
                                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-sm ${getPluginArtworkTone(`hooks:${group.id}`, visualIndex)}`}
                                  >
                                    {hook.emoji || <ConnectorIcon className="h-4 w-4" />}
                                  </div>
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {hook.name}
                                  </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                  {renderToggle(hook)}
                                </div>
                              </div>
                              <Tooltip
                                content={hook.description}
                                position="bottom"
                                maxWidth="360px"
                                className="ml-10 block min-w-0 pr-2"
                              >
                                <p className="truncate text-xs text-secondary">
                                  {hook.description}
                                </p>
                              </Tooltip>
                              <div className="ml-10 mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
                                {hook.managedByPlugin && hook.pluginId && (
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation();
                                      onOpenExtension?.(hook.pluginId as string);
                                    }}
                                    disabled={!onOpenExtension}
                                    aria-label={i18nService
                                      .t('openExtensionDetails')
                                      .replace('{name}', hook.pluginId)}
                                    className="relative z-10 min-w-0 max-w-28 truncate text-[10px] font-medium text-purple-600 transition-colors enabled:hover:text-primary disabled:cursor-default dark:text-purple-400"
                                  >
                                    {hook.pluginId}
                                  </button>
                                )}
                                {hook.events.slice(0, 2).map(event => (
                                  <span
                                    key={event}
                                    className="min-w-0 max-w-24 truncate rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary"
                                  >
                                    {event}
                                  </span>
                                ))}
                                {hook.events.length > 2 && (
                                  <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                                    +{hook.events.length - 2}
                                  </span>
                                )}
                                {missingSummary && (
                                  <Tooltip
                                    content={missingSummary}
                                    position="bottom"
                                    maxWidth="360px"
                                    className="shrink-0"
                                  >
                                    <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">
                                      {i18nService.t('hookStatusMissing')}
                                    </span>
                                  </Tooltip>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </PluginGroupSection>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-10 text-center text-sm text-secondary">
          <p>{i18nService.t('pluginHubHooksMarketplaceUnavailable')}</p>
          {!gatewayOffline && (
            <button
              type="button"
              onClick={() => setImportPickerOpen(true)}
              disabled={importing}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary disabled:opacity-50"
            >
              <ArrowUpTrayIcon className="h-4 w-4" />
              {i18nService.t('importHook')}
            </button>
          )}
        </div>
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

            <PluginMarkdownDescription className="mb-4" content={selectedHook.description} />

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

            <div className="flex items-center justify-between gap-3">
              <Tooltip content={i18nService.t('openFolder')} position="top">
                <button
                  type="button"
                  onClick={() => handleOpenFolder(selectedHook)}
                  className="rounded-lg border border-border p-2 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                  aria-label={i18nService.t('openFolder')}
                >
                  <FolderIcon className="h-4 w-4" />
                </button>
              </Tooltip>
              {(selectedHook.management?.remove.allowed ??
                (selectedHook.source === 'openclaw-managed' &&
                  !selectedHook.managedByPlugin)) && (
                <Tooltip content={i18nService.t('deleteHook')} position="top">
                  <button
                    type="button"
                    onClick={() => {
                      const hook = selectedHook;
                      setSelectedHook(null);
                      handleDeleteClick(hook);
                    }}
                    className="rounded-lg p-2 text-red-500 transition-colors hover:bg-red-500/10"
                    aria-label={i18nService.t('deleteHook')}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
            </div>
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
