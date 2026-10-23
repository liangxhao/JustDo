import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  FolderIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline';
import { PluginHubScope } from '@shared/plugins/management';
import { PluginKind } from '@shared/plugins/marketplace';
import { PluginOperationAction } from '@shared/plugins/pluginOperation';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { HookEntry, HookListResult } from '@/features/plugins/hooks/hook';
import { hookService } from '@/features/plugins/hooks/hookService';
import ExtensionBadge from '@/features/plugins/shared/ExtensionBadge';
import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginCard from '@/features/plugins/shared/PluginCard';
import {
  PLUGIN_DETAIL_BODY_CLASS_NAME,
  PLUGIN_DETAIL_FOOTER_CLASS_NAME,
  PLUGIN_DETAIL_MODAL_CLASS_NAME,
  PluginDetailHeader,
} from '@/features/plugins/shared/PluginDetail';
import PluginGroupSection from '@/features/plugins/shared/PluginGroupSection';
import type { PluginHubManagerProps } from '@/features/plugins/shared/pluginHubTypes';
import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import {
  pluginOperationFailure,
  pluginOperationRefreshFailure,
} from '@/features/plugins/shared/pluginMutationFeedback';
import { reportPluginOperationFailure } from '@/features/plugins/shared/pluginOperationService';
import { comparePluginNames } from '@/features/plugins/shared/pluginOrdering';
import PluginStateButton, {
  PluginLockedIndicator,
} from '@/features/plugins/shared/PluginStateButton';
import { i18nService } from '@/services/i18n';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import ErrorMessage from '@/shared/components/ui/ErrorMessage';
import Modal from '@/shared/components/ui/Modal';
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
  const [detailArtworkTone, setDetailArtworkTone] = useState(() =>
    getPluginArtworkTone('hooks:user'),
  );
  const [restartNotice, setRestartNotice] = useState(false);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState('');
  const [hookPendingDelete, setHookPendingDelete] = useState<HookEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState('');
  const inventoryReadGeneration = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let isActive = true;
    const loadHooks = async (force = false) => {
      const generation = ++inventoryReadGeneration.current;
      setIsLoading(true);
      const result = await hookService.loadHooks({ force });
      if (!isActive || generation !== inventoryReadGeneration.current) return;
      setHooks(result.hooks ?? []);
      setSelectedHook(current => result.hooks?.find(hook => hook.id === current?.id) ?? null);
      setWorkspaceDir(result.workspaceDir ?? '');
      setManagedHooksDir(result.managedHooksDir ?? '');
      setGatewayOffline(hookService.isGatewayOffline());
      setActionError(result.success ? '' : result.error || i18nService.t('hookLoadFailed'));
      setIsLoading(false);
    };
    loadHooks();
    const stop = window.electron.extensions.onChanged(() => {
      void loadHooks(true);
    });
    return () => {
      isActive = false;
      mounted.current = false;
      inventoryReadGeneration.current += 1;
      stop();
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
      hook.scope === PluginHubScope.SYSTEM || hook.source === 'openclaw-bundled';
    const userHooks = filteredHooks.filter(hook => !isSystemHook(hook)).sort(comparePluginNames);
    const systemHooks = filteredHooks.filter(isSystemHook).sort(comparePluginNames);
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

  const reconcileFailedMutation = async (generation: number) => {
    const result = await hookService.loadHooks({ force: true });
    if (!mounted.current || generation !== inventoryReadGeneration.current) return;
    const currentHooks = hookService.getHooks();
    setHooks(currentHooks);
    setSelectedHook(current => currentHooks.find(hook => hook.id === current?.id) ?? null);
    setWorkspaceDir(result.workspaceDir ?? workspaceDir);
    setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
    setGatewayOffline(hookService.isGatewayOffline());
  };

  const handleToggleHook = async (hook: HookEntry) => {
    if (updatingHookIds.has(hook.id)) return;
    const capability = hook.enabled ? hook.management?.disable : hook.management?.enable;
    if (capability && !capability.allowed) {
      reportPluginOperationFailure(
        {
          kind: PluginKind.HOOK,
          action: hook.enabled ? PluginOperationAction.DISABLE : PluginOperationAction.ENABLE,
          label: hook.name,
        },
        { message: i18nService.t('hookManagedByPlugin') },
      );
      return;
    }
    if (!hook.enabled && !hook.requirementsSatisfied) {
      reportPluginOperationFailure(
        { kind: PluginKind.HOOK, action: PluginOperationAction.ENABLE, label: hook.name },
        { message: i18nService.t('hookMissingRequirements') },
      );
      return;
    }

    setActionError('');
    const generation = ++inventoryReadGeneration.current;
    setHookUpdating(hook.id, true);
    try {
      const result = await hookService.setHookEnabled(hook.id, !hook.enabled);
      if (!mounted.current) return;
      const currentHooks = hookService.getHooks();
      setHooks(currentHooks);
      setGatewayOffline(hookService.isGatewayOffline());
      setWorkspaceDir(result.workspaceDir ?? workspaceDir);
      setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
      setRestartNotice(Boolean(result.restartRequired));
      setSelectedHook(current =>
        current?.id === hook.id
          ? (currentHooks.find(item => item.id === hook.id) ?? null)
          : current,
      );
    } catch {
      if (!mounted.current || generation !== inventoryReadGeneration.current) return;
      setHooks(hookService.getHooks());
      setGatewayOffline(hookService.isGatewayOffline());
    } finally {
      if (mounted.current) {
        setHookUpdating(hook.id, false);
        if (generation === inventoryReadGeneration.current) setIsLoading(false);
      }
    }
  };

  const handleOpenFolder = async (hook: HookEntry) => {
    const targetPath = hook.baseDir || managedHooksDir || workspaceDir;
    await window.electron.shell.openPath(targetPath);
  };

  const handleImportHooks = async (sourceType: 'folders' | 'archives') => {
    if (importing) return;
    const batchStartedAt = Date.now();
    const reportFailure = (failure: Parameters<typeof reportPluginOperationFailure>[1]) =>
      reportPluginOperationFailure(
        {
          kind: PluginKind.HOOK,
          action: PluginOperationAction.INSTALL,
          label: i18nService.t('importHook'),
        },
        { ...failure, elapsedMs: Date.now() - batchStartedAt },
      );
    let generation: number | undefined;
    try {
      setImportPickerOpen(false);
      setImporting(true);
      setActionError('');
      setImportSuccess('');

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
      if (!selection.success || !selection.paths?.length) {
        if (selection.error) reportFailure({ message: selection.error });
        return;
      }
      generation = ++inventoryReadGeneration.current;

      const results: (HookListResult & { sourcePath: string })[] = [];
      for (const sourcePath of selection.paths) {
        const result: HookListResult = await hookService
          .importHook(sourcePath, { reportFailure: false })
          .catch(error => ({
            success: false,
            error: error instanceof Error ? error.message : i18nService.t('hookImportFailed'),
          }));
        results.push({ sourcePath, ...result });
        if (result.success && mounted.current) {
          setHooks(hookService.getHooks());
          setWorkspaceDir(result.workspaceDir ?? workspaceDir);
          setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
        }
      }
      if (results.some(result => !result.success)) await reconcileFailedMutation(generation);

      const importedIds = results
        .filter(result => result.success)
        .map(result => result.hookId)
        .filter((id): id is string => Boolean(id));
      const failed = results.filter(result => !result.success);
      const refreshFailed =
        results.some(result => result.refreshWarning) || hookService.hasHookLoadFailed();
      if (importedIds.length > 0 && failed.length === 0 && !refreshFailed && mounted.current) {
        setImportSuccess(importedIds.join(', '));
        setTimeout(() => setImportSuccess(''), 5000);
      }
      if (failed.length > 0)
        reportFailure({
          ...(failed.length === 1 && importedIds.length === 0
            ? pluginOperationFailure(failed[0], i18nService.t('hookImportFailed'))
            : {}),
          message:
            importedIds.length > 0
              ? i18nService
                  .t('pluginImportPartialSummary')
                  .replace('{successCount}', String(importedIds.length))
                  .replace('{failureCount}', String(failed.length))
              : i18nService.t('hookImportFailed'),
          ...(refreshFailed ? { details: i18nService.t('pluginOperationRefreshFailed') } : {}),
          items: results.map(result => ({
            label: result.hookId || result.sourcePath.split(/[/\\]/).pop() || result.sourcePath,
            ...(result.success
              ? { message: i18nService.t('pluginImportItemSuccess'), type: 'success' as const }
              : {
                  ...pluginOperationFailure(result, i18nService.t('hookImportFailed')),
                  type: 'error' as const,
                }),
          })),
        });
      else if (refreshFailed) reportFailure(pluginOperationRefreshFailure());
      if (mounted.current) {
        setGatewayOffline(hookService.isGatewayOffline());
      }
    } catch (error) {
      reportFailure({
        message: error instanceof Error ? error.message : i18nService.t('hookImportFailed'),
      });
      if (generation !== undefined) await reconcileFailedMutation(generation);
    } finally {
      if (mounted.current) {
        setImporting(false);
        if (generation !== undefined && generation === inventoryReadGeneration.current) {
          setIsLoading(false);
        }
      }
    }
  };

  const handleDeleteClick = (hook: HookEntry) => {
    if (hook.management && !hook.management.remove.allowed) return;
    setSelectedHook(null);
    setHookPendingDelete(hook);
  };

  const handleConfirmDelete = async () => {
    if (!hookPendingDelete || deleting) return;
    const generation = ++inventoryReadGeneration.current;
    setDeleting(true);
    setActionError('');
    try {
      const result = await hookService.deleteHook(hookPendingDelete.id);
      if (!mounted.current) return;
      setHooks(hookService.getHooks());
      setGatewayOffline(hookService.isGatewayOffline());
      setWorkspaceDir(result.workspaceDir ?? workspaceDir);
      setManagedHooksDir(result.managedHooksDir ?? managedHooksDir);
      setRestartNotice(Boolean(result.restartRequired));
      if (!result.refreshWarning) setDeleteSuccess(hookPendingDelete.name);
      setHookPendingDelete(null);
      setTimeout(() => setDeleteSuccess(''), 5000);
    } catch {
      if (!mounted.current || generation !== inventoryReadGeneration.current) return;
      setHooks(hookService.getHooks());
      setGatewayOffline(hookService.isGatewayOffline());
    } finally {
      if (mounted.current) {
        setDeleting(false);
        if (generation === inventoryReadGeneration.current) setIsLoading(false);
      }
    }
  };

  const renderToggle = (hook: HookEntry) => {
    const capability = hook.enabled ? hook.management?.disable : hook.management?.enable;
    if (capability && !capability.allowed && capability.reason === 'managed-by-extension') {
      return (
        <PluginLockedIndicator
          checked={hook.enabled}
          label={i18nService.t('hookManagedByPlugin')}
        />
      );
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
                      <div className="grid min-w-0 auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                        {group.hooks.map((hook, visualIndex) => {
                          const artworkTone = getPluginArtworkTone(
                            `hooks:${group.id}`,
                            visualIndex,
                          );
                          return (
                            <PluginCard
                              key={`${group.id}:${hook.id}`}
                              onOpen={() => {
                                setSelectedHook(hook);
                                setDetailArtworkTone(artworkTone);
                              }}
                              openLabel={`${i18nService.t('subtaskShowInfo')}: ${hook.name}`}
                              icon={
                                <div
                                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-sm ${artworkTone}`}
                                >
                                  {hook.emoji || <ConnectorIcon className="h-4 w-4" />}
                                </div>
                              }
                              iconBadge={
                                hook.managedByPlugin ? (
                                  <ExtensionBadge
                                    label={
                                      hook.pluginId
                                        ? i18nService
                                            .t('openExtensionDetails')
                                            .replace('{name}', hook.pluginId)
                                        : undefined
                                    }
                                    onOpen={
                                      hook.pluginId && onOpenExtension
                                        ? () => onOpenExtension(hook.pluginId as string)
                                        : undefined
                                    }
                                  />
                                ) : undefined
                              }
                              title={
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {hook.name}
                                </span>
                              }
                              actions={renderToggle(hook)}
                              description={
                                <Tooltip
                                  content={hook.description}
                                  position="bottom"
                                  maxWidth="360px"
                                  className="block w-full"
                                >
                                  <p className="line-clamp-2 break-words">{hook.description}</p>
                                </Tooltip>
                              }
                            />
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
            className={PLUGIN_DETAIL_MODAL_CLASS_NAME}
          >
            <PluginDetailHeader
              title={selectedHook.name}
              icon={selectedHook.emoji || <ConnectorIcon className="h-5 w-5" />}
              artworkTone={detailArtworkTone}
              onClose={() => setSelectedHook(null)}
            />

            <div className={PLUGIN_DETAIL_BODY_CLASS_NAME}>
              <PluginMarkdownDescription content={selectedHook.description} />

              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-secondary">
                    {i18nService.t('hookEvents')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedHook.events.length > 0 ? (
                      selectedHook.events.map(event => (
                        <span
                          key={event}
                          className="max-w-full break-all rounded-md bg-surface-raised px-2 py-1 font-mono text-[11px] leading-4 text-secondary"
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
              </div>
              {selectedHook.managedByPlugin && (
                <p className="flex min-w-0 items-start gap-1.5 text-[11px] leading-5 text-secondary">
                  <LockClosedIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{i18nService.t('hookManagedByPlugin')}</span>
                </p>
              )}
            </div>

            <div
              className={`${PLUGIN_DETAIL_FOOTER_CLASS_NAME} mt-3 justify-between border-t border-border/60`}
            >
              <div className="flex shrink-0 items-center gap-2">
                <Tooltip content={i18nService.t('openFolder')} position="top">
                  <button
                    type="button"
                    onClick={() => handleOpenFolder(selectedHook)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
              {selectedHook.managedByPlugin && selectedHook.pluginId && (
                <div className="min-w-0 flex-1 text-right text-[11px] leading-4 text-purple-700 dark:text-purple-300">
                  {onOpenExtension ? (
                    <button
                      type="button"
                      title={i18nService
                        .t('openExtensionDetails')
                        .replace('{name}', selectedHook.pluginId)}
                      onClick={() => {
                        const pluginId = selectedHook.pluginId;
                        if (!pluginId) return;
                        setSelectedHook(null);
                        onOpenExtension(pluginId);
                      }}
                      className="max-w-full rounded-sm text-right [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      {i18nService.t('pluginScope.extension')} · {selectedHook.pluginId}
                    </button>
                  ) : (
                    <span className="[overflow-wrap:anywhere]">
                      {i18nService.t('pluginScope.extension')} · {selectedHook.pluginId}
                    </span>
                  )}
                </div>
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
                aria-busy={deleting || undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deleting && <ArrowPathIcon aria-hidden="true" className="h-4 w-4 animate-spin" />}
                <span role={deleting ? 'status' : undefined}>
                  {deleting ? i18nService.t('hookDeleting') : i18nService.t('delete')}
                </span>
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
};

export default HookManager;
