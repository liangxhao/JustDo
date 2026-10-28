import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  FolderIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { PluginHubScope } from '@shared/plugins/management';
import { PluginKind } from '@shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationFeedback,
} from '@shared/plugins/pluginOperation';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import {
  InstalledMarketplaceAction,
  MarketplaceFeedback,
} from '@/features/plugins/marketplace/MarketplaceActions';
import MarketplaceToolbar from '@/features/plugins/marketplace/MarketplaceToolbar';
import { MarketplaceResults } from '@/features/plugins/marketplace/MarketplaceView';
import {
  MarketplaceFilter,
  usePluginMarketplace,
} from '@/features/plugins/marketplace/usePluginMarketplace';
import { observeDeferredInventoryRefresh } from '@/features/plugins/shared/deferredInventoryRefresh';
import ExtensionBadge from '@/features/plugins/shared/ExtensionBadge';
import OperationResultModal, {
  type OperationResult,
} from '@/features/plugins/shared/OperationResultModal';
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
import { Skill } from '@/features/plugins/skills/skill';
import {
  getMissingRequirementCount,
  getMissingSkillDependencies,
} from '@/features/plugins/skills/skillRequirements';
import { skillService } from '@/features/plugins/skills/skillService';
import { setSkills } from '@/features/plugins/skills/skillSlice';
import { i18nService } from '@/services/i18n';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Modal from '@/shared/components/ui/Modal';
import Tooltip from '@/shared/components/ui/Tooltip';
import { RootState } from '@/store';

import SkillWorkshopPanel from './SkillWorkshopPanel';

interface SkillsManagerProps extends PluginHubManagerProps {
  readOnly?: boolean;
  onCreateByChat?: () => void;
}

const SkillsManager: React.FC<SkillsManagerProps> = ({
  readOnly,
  searchQuery: sharedSearchQuery,
  visibility = 'all',
}) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const skillSearchQuery = sharedSearchQuery ?? localSearchQuery;
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [detailArtworkTone, setDetailArtworkTone] = useState(() =>
    getPluginArtworkTone('skills:personal'),
  );
  const selectedSkill = skills.find(skill => skill.id === selectedSkillId);
  const selectedSkillMissing = selectedSkill
    ? getMissingSkillDependencies(selectedSkill)
    : undefined;
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingSkillIds, setUpdatingSkillIds] = useState<Set<string>>(() => new Set());
  const [actionOutcome, setActionOutcome] = useState<OperationResult | null>(null);
  const mounted = useRef(false);
  const inventoryReadGeneration = useRef(0);

  // Gateway offline state
  const [gatewayOffline, setGatewayOffline] = useState(false);
  const [inventoryReady, setInventoryReady] = useState(false);

  useEffect(() => {
    if (selectedSkillId && !skills.some(skill => skill.id === selectedSkillId)) {
      setSelectedSkillId(null);
    }
  }, [selectedSkillId, skills]);

  useEffect(() => {
    mounted.current = true;
    let isActive = true;
    const generation = ++inventoryReadGeneration.current;
    const loadSkills = async () => {
      // Parent extensions can change while this category is unmounted. Keep the
      // shared read-only reconciliation active while native discovery catches up.
      const loadedSkills = await skillService.refreshInventoryAfterMutation();
      if (!isActive || generation !== inventoryReadGeneration.current) return;
      dispatch(setSkills(loadedSkills));
      setGatewayOffline(skillService.isGatewayOffline());
      setInventoryReady(!skillService.hasInventoryReadFailed());
    };
    const stopInventoryUpdates = skillService.subscribeInventory(loadedSkills => {
      if (!isActive) return;
      inventoryReadGeneration.current += 1;
      dispatch(setSkills(loadedSkills));
      setGatewayOffline(skillService.isGatewayOffline());
      setInventoryReady(!skillService.hasInventoryReadFailed());
    });
    loadSkills();
    const refresh = observeDeferredInventoryRefresh(() => {
      void skillService.refreshInventoryAfterMutation();
    });
    const stopExtensionChanges = window.electron.extensions.onChanged(() => {
      refresh.request();
    });

    return () => {
      isActive = false;
      mounted.current = false;
      inventoryReadGeneration.current += 1;
      stopInventoryUpdates();
      stopExtensionChanges();
      refresh.dispose();
    };
  }, [dispatch]);

  const refreshSkillList = async (options: { force?: boolean } = {}) => {
    const generation = ++inventoryReadGeneration.current;
    const loadedSkills = await skillService.loadSkills(options);
    const success = !skillService.hasInventoryReadFailed();
    if (!mounted.current || generation !== inventoryReadGeneration.current) return success;
    dispatch(setSkills(loadedSkills));
    setGatewayOffline(skillService.isGatewayOffline());
    setInventoryReady(!skillService.hasInventoryReadFailed());
    return success;
  };

  const installedMarketplaceSkills = useMemo(
    () =>
      skills.map(skill => ({
        id: skill.id,
        version: skill.version,
        installPath: skill.skillPath.replace(/[\\/]SKILL\.md$/i, ''),
        updateEligible: skill.ownershipScope !== PluginHubScope.SYSTEM,
      })),
    [skills],
  );
  const marketplace = usePluginMarketplace({
    kind: PluginKind.SKILL,
    installed: installedMarketplaceSkills,
    inventoryReady,
    searchQuery: skillSearchQuery,
    readOnly,
    runtimeUnavailable: gatewayOffline,
    onInstalled: async () => {
      await skillService.refreshInventoryAfterMutation();
      if (skillService.hasInventoryReadFailed()) throw new Error('Inventory unavailable');
    },
  });

  const filteredSkills = skills.filter(skill =>
    marketplace.matchesInstalled(
      skill.id,
      [
        skill.id,
        skill.name,
        skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description),
      ].some(value => value.toLowerCase().includes(skillSearchQuery.trim().toLowerCase())),
    ),
  );
  const skillOwnershipGroups = useMemo(() => {
    const userSkills = filteredSkills
      .filter(skill => skill.ownershipScope !== PluginHubScope.SYSTEM)
      .sort(comparePluginNames);
    const systemSkills = filteredSkills
      .filter(skill => skill.ownershipScope === PluginHubScope.SYSTEM)
      .sort(comparePluginNames);
    return [
      ...(userSkills.length > 0 || !skillSearchQuery.trim()
        ? [{ id: 'user' as const, skills: userSkills }]
        : []),
      ...(systemSkills.length > 0 ? [{ id: 'system' as const, skills: systemSkills }] : []),
    ];
  }, [filteredSkills, skillSearchQuery]);

  const getScopeLabel = (scope: Skill['scope']) =>
    i18nService.t(`pluginScope.${scope || PluginHubScope.OTHER}`);
  const getSourceLabel = (skill: Skill) => {
    switch (skill.source) {
      case 'openclaw-workshop':
      case 'openclaw-workspace':
      case 'agents-skills-project':
      case 'agents-skills-personal':
      case 'openclaw-managed':
      case 'openclaw-bundled':
      case 'openclaw-custodian':
      case 'openclaw-extra':
        return i18nService.t(`pluginSkillSource.${skill.source}`);
      default:
        return i18nService.t('pluginSkillSource.unknown');
    }
  };

  const getResolutionChangeMessage = (before: Skill, after: Skill[]): string | null => {
    const resolved = after.find(skill => skill.name === before.name);
    if (!resolved)
      return i18nService.t('skillResolutionUnavailable').replace('{name}', before.name);
    if (resolved.source === before.source && resolved.skillPath === before.skillPath) return null;
    const sameSource = resolved.source === before.source;
    const beforeLabel = sameSource
      ? `${getSourceLabel(before)} · ${before.skillPath}`
      : getSourceLabel(before);
    const resolvedLabel = sameSource
      ? `${getSourceLabel(resolved)} · ${resolved.skillPath}`
      : getSourceLabel(resolved);
    return i18nService
      .t('skillResolutionChanged')
      .replace('{name}', before.name)
      .replace('{from}', beforeLabel)
      .replace('{to}', resolvedLabel);
  };

  const handleToggleSkill = async (skillId: string) => {
    if (marketplace.operationFor(skillId)?.busy) return;
    if (readOnly || updatingSkillIds.has(skillId)) return;
    if (gatewayOffline) {
      reportPluginOperationFailure(
        {
          kind: PluginKind.SKILL,
          action: PluginOperationAction.ENABLE,
          label: skills.find(skill => skill.id === skillId)?.name || skillId,
        },
        { message: i18nService.t('gatewayOffline') },
      );
      return;
    }
    const targetSkill = skills.find(skill => skill.id === skillId);
    if (!targetSkill) return;
    const capability = targetSkill.enabled
      ? targetSkill.management.disable
      : targetSkill.management.enable;
    if (!capability.allowed) return;
    inventoryReadGeneration.current += 1;
    setUpdatingSkillIds(current => new Set(current).add(skillId));
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, !targetSkill.enabled);
      if (!mounted.current) return;
      dispatch(setSkills(updatedSkills));
      setGatewayOffline(skillService.isGatewayOffline());
      const resolutionMessage = updatedSkills.some(skill => skill.name === targetSkill.name)
        ? getResolutionChangeMessage(targetSkill, updatedSkills)
        : null;
      if (resolutionMessage && !skillService.hasInventoryReadFailed()) {
        setActionOutcome({
          type: 'success',
          title: i18nService.t('skillStatusUpdated'),
          message: resolutionMessage,
        });
      }
    } catch {
      if (!mounted.current) return;
      setGatewayOffline(skillService.isGatewayOffline());
    } finally {
      if (mounted.current) {
        setUpdatingSkillIds(current => {
          const next = new Set(current);
          next.delete(skillId);
          return next;
        });
      }
    }
  };

  const handleImportSkills = async (sourceType: 'folders' | 'archives') => {
    if (readOnly || importing) return;
    const batchStartedAt = Date.now();
    const reportFailure = (failure: Parameters<typeof reportPluginOperationFailure>[1]) =>
      reportPluginOperationFailure(
        {
          kind: PluginKind.SKILL,
          action: PluginOperationAction.INSTALL,
          label: i18nService.t('importSkill'),
        },
        { ...failure, elapsedMs: Date.now() - batchStartedAt },
      );

    try {
      setImportPickerOpen(false);
      setImporting(true);
      setActionOutcome(null);

      const result =
        sourceType === 'folders'
          ? await window.electron.dialog.selectFolders({
              title: i18nService.t('selectSkillFolders'),
            })
          : await window.electron.dialog.selectFiles({
              title: i18nService.t('selectSkillArchives'),
              filters: [
                {
                  name: i18nService.t('skillArchiveFiles'),
                  extensions: ['zip', 'tar', 'gz', 'tgz'],
                },
              ],
            });

      if (!result.success) {
        if (result.error) reportFailure({ message: result.error });
        return;
      }
      if (!result.paths || result.paths.length === 0) {
        return;
      }

      const results: (PluginOperationFeedback & {
        path: string;
        success: boolean;
        skillId?: string;
        error?: string;
      })[] = [];
      for (const sourcePath of result.paths) {
        const importResult = await skillService.importSkill(sourcePath, { reportFailure: false });
        results.push({
          path: sourcePath,
          ...importResult,
        });
      }

      // Check results
      const succeeded = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      const refreshSucceeded = await refreshSkillList({ force: true });
      const refreshFailed = !refreshSucceeded || results.some(item => item.refreshWarning);

      if (succeeded.length > 0 && failed.length === 0 && !refreshFailed && mounted.current) {
        const skillIds = succeeded
          .map(r => r.skillId)
          .filter(Boolean)
          .join(', ');
        setActionOutcome({
          type: 'success',
          title: i18nService.t('importSkill'),
          message: i18nService.t('skillImportSuccess').replace('{skillId}', skillIds),
        });
      }

      if (failed.length > 0) {
        const partial = succeeded.length > 0;
        reportFailure({
          ...(failed.length === 1 && succeeded.length === 0
            ? pluginOperationFailure(failed[0], i18nService.t('skillImportFailed'))
            : {}),
          message: partial
            ? i18nService
                .t('pluginImportPartialSummary')
                .replace('{successCount}', String(succeeded.length))
                .replace('{failureCount}', String(failed.length))
            : i18nService.t('skillImportFailed'),
          ...(refreshFailed ? { details: i18nService.t('pluginOperationRefreshFailed') } : {}),
          items: [
            ...succeeded.map(r => ({
              label: r.skillId || r.path.split(/[/\\]/).pop() || r.path,
              message: i18nService.t('pluginImportItemSuccess'),
              type: 'success' as const,
            })),
            ...failed.map(r => ({
              label: r.path.split(/[/\\]/).pop() || r.path,
              ...pluginOperationFailure(r, i18nService.t('skillImportFailed')),
              type: 'error' as const,
            })),
          ],
        });
      }

      if (failed.length === 0 && refreshFailed) reportFailure(pluginOperationRefreshFailure());
    } catch (error) {
      reportFailure({
        message: error instanceof Error ? error.message : i18nService.t('skillImportFailed'),
      });
    } finally {
      if (mounted.current) setImporting(false);
    }
  };

  const handleCancelDeleteSkill = () => {
    if (deleting) return;
    setSkillPendingDelete(null);
  };

  // Skill action handlers
  const handleOpenFolder = async (skill: Skill) => {
    const skillPath = skill.skillPath;
    const lastSep = Math.max(skillPath.lastIndexOf('/'), skillPath.lastIndexOf('\\'));
    const skillDir = lastSep >= 0 ? skillPath.substring(0, lastSep) : skillPath;
    await window.electron.shell.openPath(skillDir);
  };

  const handleDeleteClick = (skill: Skill) => {
    if (marketplace.operationFor(skill.id)?.busy) return;
    if (!skill.management.remove.allowed) return;
    setSelectedSkillId(null);
    setSkillPendingDelete(skill);
  };

  const handleConfirmDelete = async () => {
    if (!skillPendingDelete || deleting) return;

    const pendingSkill = skillPendingDelete;
    setDeleting(true);
    try {
      const result = await skillService.deleteSkill(pendingSkill.id, pendingSkill.source);
      if (result.success && result.skills) {
        dispatch(setSkills(result.skills));
        setSelectedSkillId(null);
        const resolutionMessage = result.skills.some(skill => skill.name === pendingSkill.name)
          ? getResolutionChangeMessage(pendingSkill, result.skills)
          : null;
        const deleteMessage = i18nService
          .t('skillDeleteSuccess')
          .replace('{name}', pendingSkill.name);
        if (!result.refreshWarning && mounted.current)
          setActionOutcome({
            type: 'success',
            title: i18nService.t('deleteSkill'),
            message: resolutionMessage ? `${deleteMessage}\n\n${resolutionMessage}` : deleteMessage,
          });
      }
    } catch {
      // The service owns failure delivery even when this category unmounts.
    } finally {
      setSkillPendingDelete(null);
      setDeleting(false);
    }
  };

  // Render skill eligibility status
  const renderSkillStatus = (skill: Skill) => {
    const missing = getMissingSkillDependencies(skill);
    const missingCount = getMissingRequirementCount(missing);
    if (missingCount > 0) {
      const missingItems = [
        ...(missing?.bins ?? []),
        ...(missing?.env ?? []),
        ...(missing?.config ?? []),
        ...(missing?.os ?? []),
        ...(missing?.anyBins?.length
          ? [`${i18nService.t('missingAnyBins')}: ${missing.anyBins.join(', ')}`]
          : []),
      ];
      return (
        <Tooltip
          content={`${i18nService.t('skillMissingRequirements')}: ${missingItems.join(', ')}`}
          position="bottom"
          maxWidth="360px"
        >
          <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600 text-[10px] font-medium">
            {missingCount} {i18nService.t('missing')}
          </span>
        </Tooltip>
      );
    }
    return null;
  };

  const importSkillAction =
    !readOnly && !gatewayOffline ? (
      <Tooltip content={i18nService.t('importSkillTooltip')} position="bottom">
        <button
          type="button"
          onClick={() => setImportPickerOpen(true)}
          disabled={importing}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground ${
            importing ? 'cursor-not-allowed opacity-50' : ''
          }`}
        >
          <ArrowUpTrayIcon className="h-4 w-4" />
          <span>
            {importing ? i18nService.t('importSkillProgress') : i18nService.t('importSkill')}
          </span>
        </button>
      </Tooltip>
    ) : undefined;

  const renderInstalledCard = (skill: Skill, visualIndex: number) => {
    const artworkTone = getPluginArtworkTone(`skills:${skill.ownershipScope}`, visualIndex);
    const toggleAllowed = skill.enabled
      ? skill.management.disable.allowed
      : skill.management.enable.allowed;
    const status = renderSkillStatus(skill);
    const showScope =
      skill.scope !== PluginHubScope.EXTENSION &&
      skill.scope !== PluginHubScope.PERSONAL &&
      skill.scope !== PluginHubScope.SYSTEM;
    return (
      <PluginCard
        key={skill.id}
        onOpen={() => {
          setSelectedSkillId(skill.id);
          setDetailArtworkTone(artworkTone);
        }}
        openLabel={`${i18nService.t('subtaskShowInfo')}: ${skill.name}`}
        icon={
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${artworkTone}`}
          >
            <SparklesIcon className="h-4 w-4" />
          </div>
        }
        iconBadge={skill.scope === PluginHubScope.EXTENSION ? <ExtensionBadge /> : undefined}
        title={
          <span className="block truncate text-sm font-medium text-foreground">{skill.name}</span>
        }
        actions={
          <>
            <InstalledMarketplaceAction
              controller={marketplace}
              id={skill.id}
              disabled={updatingSkillIds.has(skill.id)}
            />
            {!toggleAllowed && !gatewayOffline ? (
              <PluginLockedIndicator
                checked={skill.enabled}
                label={i18nService.t('pluginManagedActionUnavailable')}
              />
            ) : (
              <PluginStateButton
                checked={skill.enabled}
                label={i18nService.t(skill.enabled ? 'disableSkill' : 'enableSkill')}
                disabled={
                  marketplace.operationFor(skill.id)?.busy ||
                  readOnly ||
                  gatewayOffline ||
                  !toggleAllowed ||
                  updatingSkillIds.has(skill.id)
                }
                busy={updatingSkillIds.has(skill.id)}
                onToggle={() => {
                  if (!readOnly && !gatewayOffline && toggleAllowed) {
                    void handleToggleSkill(skill.id);
                  }
                }}
              />
            )}
          </>
        }
        description={
          <Tooltip
            content={skillService.getLocalizedSkillDescription(
              skill.id,
              skill.name,
              skill.description,
            )}
            position="bottom"
            maxWidth="360px"
            className="block w-full"
          >
            <p className="line-clamp-2 break-words">
              {skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)}
            </p>
          </Tooltip>
        }
        footer={
          status || showScope || skill.version ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {status}
              {showScope && (
                <span className="shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 font-medium">
                  {getScopeLabel(skill.scope)}
                </span>
              )}
              {skill.version && (
                <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                  v{skill.version}
                </span>
              )}
            </div>
          ) : undefined
        }
        feedback={<MarketplaceFeedback controller={marketplace} id={skill.id} />}
      />
    );
  };

  return (
    <div className="space-y-4">
      {/* Gateway offline warning */}
      {gatewayOffline && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
          {i18nService.t('gatewayOfflineSkillsUnavailable')}
        </div>
      )}

      <MarketplaceToolbar controller={marketplace} hasLocalMatches={filteredSkills.length > 0} />
      {visibility !== 'available' &&
        (marketplace.filter !== MarketplaceFilter.UPDATES ||
          marketplace.updateById.size > 0 ||
          marketplace.recentlyUpdated.size > 0) && (
          <section className="space-y-4">
            <div className="space-y-4">
              {sharedSearchQuery === undefined && (
                <div className="relative min-w-0 sm:max-w-md">
                  <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  <input
                    type="text"
                    placeholder={i18nService.t('searchSkills')}
                    value={skillSearchQuery}
                    onChange={e => setLocalSearchQuery(e.target.value)}
                    disabled={gatewayOffline}
                    className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              )}

              {filteredSkills.length === 0 && skillSearchQuery.trim() ? null : (
                <div className="space-y-5">
                  {skillOwnershipGroups.map(group => (
                    <PluginGroupSection
                      hideHeader={Boolean(skillSearchQuery.trim())}
                      key={group.id}
                      title={i18nService.t(`pluginGroup.${group.id}.label`)}
                      count={group.skills.length}
                      action={
                        group.id === 'user' ? (
                          <div className="flex items-center gap-1">
                            {importSkillAction}
                            {!readOnly && (
                              <SkillWorkshopPanel
                                onSkillsChanged={async () => {
                                  await refreshSkillList({ force: true });
                                }}
                              />
                            )}
                          </div>
                        ) : undefined
                      }
                      collapsible={group.id === 'system'}
                      defaultExpanded={group.id !== 'system'}
                      forceExpanded={Boolean(skillSearchQuery.trim())}
                    >
                      {group.skills.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-secondary">
                          {i18nService.t('noSkillsAvailable')}
                        </p>
                      ) : (
                        <div className="grid min-w-0 auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                          {group.skills.map(renderInstalledCard)}
                        </div>
                      )}
                    </PluginGroupSection>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

      {visibility !== 'installed' && (
        <section className={skillSearchQuery.trim() ? '' : 'border-t border-border pt-6'}>
          <MarketplaceResults
            hasLocalMatches={filteredSkills.length > 0}
            controller={marketplace}
            icon={<SparklesIcon className="h-4 w-4" />}
            renderInstalled={(id, index) => {
              const entry = skills.find(item => item.id === id);
              return entry ? renderInstalledCard(entry, index) : null;
            }}
          />
        </section>
      )}

      {/* Skill detail modal */}
      {selectedSkill &&
        createPortal(
          <Modal
            onClose={() => setSelectedSkillId(null)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className={PLUGIN_DETAIL_MODAL_CLASS_NAME}
          >
            <PluginDetailHeader
              title={selectedSkill.name}
              icon={<SparklesIcon className="h-5 w-5" />}
              artworkTone={detailArtworkTone}
              onClose={() => setSelectedSkillId(null)}
            />

            <div className={PLUGIN_DETAIL_BODY_CLASS_NAME}>
              <PluginMarkdownDescription
                content={skillService.getLocalizedSkillDescription(
                  selectedSkill.id,
                  selectedSkill.name,
                  selectedSkill.description,
                )}
              />

              {/* Eligibility info */}
              {selectedSkillMissing && getMissingRequirementCount(selectedSkillMissing) > 0 && (
                <div className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30">
                  <p className="text-xs text-yellow-600 font-medium mb-1">
                    {i18nService.t('skillMissingRequirements')}
                  </p>
                  {selectedSkillMissing.bins.length > 0 && (
                    <p className="text-xs text-secondary">
                      {i18nService.t('missingBins')}: {selectedSkillMissing.bins.join(', ')}
                    </p>
                  )}
                  {Boolean(selectedSkillMissing.anyBins?.length) && (
                    <p className="text-xs text-secondary">
                      {i18nService.t('missingAnyBins')}: {selectedSkillMissing.anyBins?.join(', ')}
                    </p>
                  )}
                  {selectedSkillMissing.env.length > 0 && (
                    <p className="text-xs text-secondary">
                      {i18nService.t('missingEnv')}: {selectedSkillMissing.env.join(', ')}
                    </p>
                  )}
                  {selectedSkillMissing.config.length > 0 && (
                    <p className="text-xs text-secondary">
                      {i18nService.t('missingConfig')}: {selectedSkillMissing.config.join(', ')}
                    </p>
                  )}
                  {selectedSkillMissing.os.length > 0 && (
                    <p className="text-xs text-secondary">
                      {i18nService.t('missingOs')}: {selectedSkillMissing.os.join(', ')}
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                {selectedSkill.version && (
                  <div className="flex items-center text-xs">
                    <span className="w-16 flex-shrink-0 text-secondary">
                      {i18nService.t('skillDetailVersion')}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-surface-raised text-foreground font-medium">
                      v{selectedSkill.version}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className={PLUGIN_DETAIL_FOOTER_CLASS_NAME}>
              <Tooltip content={i18nService.t('openFolder')} position="top">
                <button
                  type="button"
                  onClick={() => handleOpenFolder(selectedSkill)}
                  className="rounded-lg border border-border p-2 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                  aria-label={i18nService.t('openFolder')}
                >
                  <FolderIcon className="h-4 w-4" />
                </button>
              </Tooltip>
              {!readOnly && !gatewayOffline && selectedSkill.management.remove.allowed && (
                <Tooltip content={i18nService.t('deleteSkill')} position="top">
                  <button
                    type="button"
                    onClick={() => {
                      const skill = selectedSkill;
                      setSelectedSkillId(null);
                      handleDeleteClick(skill);
                    }}
                    className="rounded-lg p-2 text-red-500 transition-colors hover:bg-red-500/10"
                    aria-label={i18nService.t('deleteSkill')}
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
              {i18nService.t('importSkill')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('selectSkillSourceDescription')}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleImportSkills('folders')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <FolderIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectSkillFolders')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectSkillFoldersDescription')}
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleImportSkills('archives')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <ArchiveBoxIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectSkillArchives')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectSkillArchivesDescription')}
                </div>
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      {skillPendingDelete &&
        createPortal(
          <Modal
            onClose={handleCancelDeleteSkill}
            closeOnBackdrop={!deleting}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('deleteSkill')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('skillDeleteConfirm').replace('{name}', skillPendingDelete.name)}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDeleteSkill}
                disabled={deleting}
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {i18nService.t(deleting ? 'skillDeleting' : 'delete')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      <OperationResultModal result={actionOutcome} onClose={() => setActionOutcome(null)} />
    </div>
  );
};

export default SkillsManager;
