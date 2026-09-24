import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  FolderIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { PluginHubScope } from '@shared/plugins/management';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginGroupSection from '@/features/plugins/shared/PluginGroupSection';
import type { PluginHubManagerProps } from '@/features/plugins/shared/pluginHubTypes';
import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import PluginStateButton, {
  PluginLockedIndicator,
} from '@/features/plugins/shared/PluginStateButton';
import PluginUpdateIndicator from '@/features/plugins/shared/PluginUpdateIndicator';
import { Skill } from '@/features/plugins/skills/skill';
import SkillMarketplace from '@/features/plugins/skills/SkillMarketplace';
import { getMissingRequirementCount } from '@/features/plugins/skills/skillRequirements';
import { skillService } from '@/features/plugins/skills/skillService';
import { setSkills } from '@/features/plugins/skills/skillSlice';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import OperationResultModal, {
  type OperationResult,
} from '@/shared/components/common/OperationResultModal';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
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
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingSkillIds, setUpdatingSkillIds] = useState<Set<string>>(() => new Set());
  const [marketplaceUpdateIds, setMarketplaceUpdateIds] = useState<Set<string>>(() => new Set());
  const [actionOutcome, setActionOutcome] = useState<OperationResult | null>(null);

  // Gateway offline state
  const [gatewayOffline, setGatewayOffline] = useState(false);

  useEffect(() => {
    let isActive = true;
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
      setGatewayOffline(skillService.isGatewayOffline());
    };
    loadSkills();

    return () => {
      isActive = false;
    };
  }, [dispatch]);

  const filteredSkills = useMemo(() => {
    const query = skillSearchQuery.trim().toLowerCase();
    return skills.filter(skill => {
      const matchesSearch =
        skill.name.toLowerCase().includes(query) ||
        skillService
          .getLocalizedSkillDescription(skill.id, skill.name, skill.description)
          .toLowerCase()
          .includes(query);
      return matchesSearch;
    });
  }, [skills, skillSearchQuery]);
  const skillOwnershipGroups = useMemo(() => {
    const userSkills = filteredSkills.filter(
      skill => skill.ownershipScope !== PluginHubScope.SYSTEM,
    );
    const systemSkills = filteredSkills.filter(
      skill => skill.ownershipScope === PluginHubScope.SYSTEM,
    );
    return [
      ...(userSkills.length > 0 || !skillSearchQuery.trim()
        ? [{ id: 'user' as const, skills: userSkills }]
        : []),
      ...(systemSkills.length > 0 ? [{ id: 'system' as const, skills: systemSkills }] : []),
    ];
  }, [filteredSkills, skillSearchQuery]);
  const installedMarketplaceSkills = useMemo(
    () =>
      skills.map(skill => ({
        id: skill.id,
        version: skill.version,
        updateEligible: skill.ownershipScope !== PluginHubScope.SYSTEM,
      })),
    [skills],
  );

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
    if (updatingSkillIds.has(skillId)) return;
    if (gatewayOffline) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('skillUpdateFailed'),
        message: i18nService.t('gatewayOffline'),
      });
      return;
    }
    const targetSkill = skills.find(skill => skill.id === skillId);
    if (!targetSkill) return;
    setUpdatingSkillIds(current => new Set(current).add(skillId));
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, !targetSkill.enabled);
      dispatch(setSkills(updatedSkills));
      const resolutionMessage = getResolutionChangeMessage(targetSkill, updatedSkills);
      if (resolutionMessage) {
        setActionOutcome({
          type: 'success',
          title: i18nService.t('skillStatusUpdated'),
          message: resolutionMessage,
        });
      }
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('skillUpdateFailed'),
        message: error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'),
      });
    } finally {
      setUpdatingSkillIds(current => {
        const next = new Set(current);
        next.delete(skillId);
        return next;
      });
    }
  };

  const handleImportSkills = async (sourceType: 'folders' | 'archives') => {
    if (readOnly || importing) return;

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
        setActionOutcome({
          type: 'error',
          title: i18nService.t('skillImportFailed'),
          message: result.error || i18nService.t('skillImportFailed'),
        });
        return;
      }
      if (!result.paths || result.paths.length === 0) {
        return;
      }

      const results: { path: string; success: boolean; skillId?: string; error?: string }[] = [];
      for (const sourcePath of result.paths) {
        const importResult = await skillService.importSkill(sourcePath);
        results.push({
          path: sourcePath,
          success: importResult.success,
          skillId: importResult.skillId,
          error: importResult.error,
        });
      }

      // Check results
      const succeeded = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      if (succeeded.length > 0 && failed.length === 0) {
        const skillIds = succeeded
          .map(r => r.skillId)
          .filter(Boolean)
          .join(', ');
        setActionOutcome({
          type: 'success',
          title: i18nService.t('importSkill'),
          message: i18nService.t('skillImportSuccess').replace('{skillId}', skillIds),
        });
        // Reload skills
        const loadedSkills = await skillService.loadSkills();
        dispatch(setSkills(loadedSkills));
      }

      if (failed.length > 0) {
        const partial = succeeded.length > 0;
        setActionOutcome({
          type: 'error',
          title: i18nService.t(partial ? 'pluginImportPartialTitle' : 'skillImportFailed'),
          ...(partial
            ? {
                message: i18nService
                  .t('pluginImportPartialSummary')
                  .replace('{successCount}', String(succeeded.length))
                  .replace('{failureCount}', String(failed.length)),
              }
            : {}),
          items: [
            ...succeeded.map(r => ({
              label: r.skillId || r.path.split(/[/\\]/).pop() || r.path,
              message: i18nService.t('pluginImportItemSuccess'),
              type: 'success' as const,
            })),
            ...failed.map(r => ({
              label: r.path.split(/[/\\]/).pop() || r.path,
              message: r.error || i18nService.t('skillImportFailed'),
              type: 'error' as const,
            })),
          ],
        });
      }
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('skillImportFailed'),
        message: error instanceof Error ? error.message : i18nService.t('skillImportFailed'),
      });
    } finally {
      setImporting(false);
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
    if (!skill.management.remove.allowed) return;
    setSelectedSkill(null);
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
        setSelectedSkill(null);
        const resolutionMessage = getResolutionChangeMessage(pendingSkill, result.skills);
        setActionOutcome({
          type: 'success',
          title: i18nService.t('deleteSkill'),
          message:
            resolutionMessage ||
            i18nService.t('skillDeleteSuccess').replace('{name}', pendingSkill.name),
        });
      } else {
        setActionOutcome({
          type: 'error',
          title: i18nService.t('skillDeleteFailed'),
          message: result.error || i18nService.t('skillDeleteFailed'),
        });
      }
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('skillDeleteFailed'),
        message: error instanceof Error ? error.message : i18nService.t('skillDeleteFailed'),
      });
    } finally {
      setSkillPendingDelete(null);
      setDeleting(false);
    }
  };

  // Render skill eligibility status
  const renderSkillStatus = (skill: Skill) => {
    const missingCount = getMissingRequirementCount(skill.missing);
    if (missingCount > 0) {
      const missingItems = Object.values(skill.missing ?? {}).flat();
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

  return (
    <div className="space-y-4">
      {/* Gateway offline warning */}
      {gatewayOffline && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
          {i18nService.t('gatewayOfflineSkillsUnavailable')}
        </div>
      )}

      {visibility !== 'available' && (
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

            {filteredSkills.length === 0 && skillSearchQuery.trim() ? (
              <div className="text-center py-8 text-sm text-secondary">
                {gatewayOffline
                  ? i18nService.t('gatewayOffline')
                  : i18nService.t('noSkillsAvailable')}
              </div>
            ) : (
              <div className="space-y-5">
                {skillOwnershipGroups.map(group => (
                  <PluginGroupSection
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
                                dispatch(setSkills(await skillService.loadSkills()));
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
                      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-1 gap-x-4">
                        {group.skills.map((skill, visualIndex) => {
                          const toggleAllowed = skill.enabled
                            ? skill.management.disable.allowed
                            : skill.management.enable.allowed;
                          return (
                            <article
                              key={skill.id}
                              className="group relative min-h-16 min-w-0 cursor-pointer rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-border/70 hover:bg-surface-raised/70"
                              onClick={() => setSelectedSkill(skill)}
                            >
                              <button
                                type="button"
                                className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary"
                                aria-label={`${i18nService.t('subtaskShowInfo')}: ${skill.name}`}
                                onClick={event => {
                                  event.stopPropagation();
                                  setSelectedSkill(skill);
                                }}
                              />
                              <div className="pointer-events-none relative z-10 grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-2 [&_button]:pointer-events-auto">
                                <div
                                  className={`row-span-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${getPluginArtworkTone(`skills:${group.id}`, visualIndex)}`}
                                >
                                  <SparklesIcon className="h-4 w-4" />
                                </div>
                                <div className="flex min-w-0 items-center gap-1.5 self-center">
                                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                                    {skill.name}
                                  </span>
                                  {/* Status badge */}
                                  {renderSkillStatus(skill)}
                                  {skill.scope !== PluginHubScope.PERSONAL && (
                                    <span className="shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                                      {getScopeLabel(skill.scope)}
                                    </span>
                                  )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1 self-center">
                                  {skill.ownershipScope !== PluginHubScope.SYSTEM &&
                                    marketplaceUpdateIds.has(skill.id.toLowerCase()) && (
                                      <PluginUpdateIndicator />
                                    )}
                                  {!toggleAllowed && !gatewayOffline ? (
                                    <PluginLockedIndicator
                                      label={i18nService.t('pluginManagedActionUnavailable')}
                                    />
                                  ) : (
                                    <PluginStateButton
                                      checked={skill.enabled}
                                      label={i18nService.t(
                                        skill.enabled ? 'disableSkill' : 'enableSkill',
                                      )}
                                      disabled={
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
                                </div>
                                <Tooltip
                                  content={skillService.getLocalizedSkillDescription(
                                    skill.id,
                                    skill.name,
                                    skill.description,
                                  )}
                                  position="bottom"
                                  maxWidth="360px"
                                  className="col-start-2 block min-w-0"
                                >
                                  <p className="truncate text-xs text-secondary">
                                    {skillService.getLocalizedSkillDescription(
                                      skill.id,
                                      skill.name,
                                      skill.description,
                                    )}
                                  </p>
                                </Tooltip>

                                {skill.version && (
                                  <div className="col-start-2 mt-1 flex min-w-0 items-center text-[10px] text-secondary">
                                    <div className="flex items-center gap-2">
                                      <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                                        v{skill.version}
                                      </span>
                                    </div>
                                  </div>
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
      )}

      {visibility !== 'installed' && (
        <section className="border-t border-border pt-6">
          <SkillMarketplace
            installed={installedMarketplaceSkills}
            onUpdateIdsChange={setMarketplaceUpdateIds}
            readOnly={readOnly}
            onInstalled={async () => {
              const loadedSkills = await skillService.loadSkills();
              dispatch(setSkills(loadedSkills));
            }}
            searchQuery={skillSearchQuery}
            availableOnly={visibility === 'available'}
            runtimeUnavailable={gatewayOffline}
          />
        </section>
      )}

      {/* Skill detail modal */}
      {selectedSkill &&
        createPortal(
          <Modal
            onClose={() => setSelectedSkill(null)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-md mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-6"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-background flex items-center justify-center flex-shrink-0">
                  <SparklesIcon className="h-5 w-5 text-secondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-foreground truncate">
                    {selectedSkill.name}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSkill(null)}
                className="p-1.5 rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <PluginMarkdownDescription
              className="mb-4"
              content={skillService.getLocalizedSkillDescription(
                selectedSkill.id,
                selectedSkill.name,
                selectedSkill.description,
              )}
            />

            {/* Eligibility info */}
            {selectedSkill.missing && getMissingRequirementCount(selectedSkill.missing) > 0 && (
              <div className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 mb-4">
                <p className="text-xs text-yellow-600 font-medium mb-1">
                  {i18nService.t('skillMissingRequirements')}
                </p>
                {selectedSkill.missing.bins.length > 0 && (
                  <p className="text-xs text-secondary">
                    {i18nService.t('missingBins')}: {selectedSkill.missing.bins.join(', ')}
                  </p>
                )}
                {selectedSkill.missing.env.length > 0 && (
                  <p className="text-xs text-secondary">
                    {i18nService.t('missingEnv')}: {selectedSkill.missing.env.join(', ')}
                  </p>
                )}
                {selectedSkill.missing.config.length > 0 && (
                  <p className="text-xs text-secondary">
                    {i18nService.t('missingConfig')}: {selectedSkill.missing.config.join(', ')}
                  </p>
                )}
                {selectedSkill.missing.os.length > 0 && (
                  <p className="text-xs text-secondary">
                    {i18nService.t('missingOs')}: {selectedSkill.missing.os.join(', ')}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2 mb-5">
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

            <div className="flex items-center justify-between gap-3">
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
              {!readOnly &&
                !gatewayOffline &&
                selectedSkill.management.remove.allowed && (
                  <Tooltip content={i18nService.t('deleteSkill')} position="top">
                    <button
                      type="button"
                      onClick={() => {
                        const skill = selectedSkill;
                        setSelectedSkill(null);
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
