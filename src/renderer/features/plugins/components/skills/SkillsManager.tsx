import {
  ArchiveBoxIcon,
  ArrowUpTrayIcon,
  FolderIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import {
  canDeleteSkill,
  groupSkillsBySource,
  SkillGroupId,
} from '@/features/plugins/components/skills/skillGroups';
import SkillMarketplace from '@/features/plugins/components/skills/SkillMarketplace';
import { getMissingRequirementCount } from '@/features/plugins/components/skills/skillRequirements';
import { skillService } from '@/features/plugins/services/skillService';
import { setSkills } from '@/features/plugins/slices/skillSlice';
import { Skill } from '@/features/plugins/types/skill';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import OperationResultModal, {
  type OperationResult,
} from '@/shared/components/common/OperationResultModal';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Tooltip from '@/shared/components/ui/Tooltip';
import { RootState } from '@/store';

type SkillTab = 'installed' | 'marketplace';
interface SkillsManagerProps {
  readOnly?: boolean;
  onCreateByChat?: () => void;
}

const SkillsManager: React.FC<SkillsManagerProps> = ({ readOnly }) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SkillTab>('installed');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    const query = skillSearchQuery.toLowerCase();
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

  const groupedSkills = useMemo(() => groupSkillsBySource(filteredSkills), [filteredSkills]);

  const getGroupLabel = (groupId: SkillGroupId) => i18nService.t(`skillGroup.${groupId}.label`);

  const getGroupDescription = (groupId: SkillGroupId) =>
    i18nService.t(`skillGroup.${groupId}.description`);

  const handleToggleSkill = async (skillId: string) => {
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
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, !targetSkill.enabled);
      dispatch(setSkills(updatedSkills));
    } catch (error) {
      setActionOutcome({
        type: 'error',
        title: i18nService.t('skillUpdateFailed'),
        message: error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'),
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
    if (!canDeleteSkill(skill)) return;
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
        setActionOutcome({
          type: 'success',
          title: i18nService.t('deleteSkill'),
          message: i18nService.t('skillDeleteSuccess').replace('{name}', pendingSkill.name),
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

  return (
    <div className="space-y-4">
      {/* Gateway offline warning */}
      {gatewayOffline && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
          {i18nService.t('gatewayOfflineSkillsUnavailable')}
        </div>
      )}

      {/* Sticky toolbar: Tabs */}
      <div className="sticky top-0 z-10 bg-background pb-4 shadow-sm">
        {/* Tabs */}
        <div className="flex items-center justify-between gap-4 border-b border-border">
          <div className="flex min-w-0 items-center">
            <button
              type="button"
              onClick={() => setActiveTab('installed')}
              disabled={gatewayOffline}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                activeTab === 'installed'
                  ? 'text-foreground'
                  : 'text-secondary hover:hover:text-foreground'
              } ${gatewayOffline ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {i18nService.t('skillInstalled')}
              {skills.length > 0 && (
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised">
                  {skills.length}
                </span>
              )}
              <div
                className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
                  activeTab === 'installed' ? 'bg-primary' : 'bg-transparent'
                }`}
              />
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('marketplace')}
              disabled={gatewayOffline}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                activeTab === 'marketplace'
                  ? 'text-foreground'
                  : 'text-secondary hover:hover:text-foreground'
              } ${gatewayOffline ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {i18nService.t('skillMarketplace')}
              <div
                className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
                  activeTab === 'marketplace' ? 'bg-primary' : 'bg-transparent'
                }`}
              />
            </button>
          </div>
          <p className="min-w-0 truncate pb-2 text-right text-sm text-secondary">
            {i18nService.t('skillsDescriptionGateway')}
          </p>
        </div>
      </div>

      <div>
        {activeTab === 'installed' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
              <div className="relative min-w-0 flex-1 sm:max-w-md">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
                <input
                  type="text"
                  placeholder={i18nService.t('searchSkills')}
                  value={skillSearchQuery}
                  onChange={e => setSkillSearchQuery(e.target.value)}
                  disabled={gatewayOffline}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
              {!readOnly && !gatewayOffline && (
                <div className="w-full sm:ml-auto sm:w-auto">
                  <Tooltip
                    className="w-full sm:w-auto"
                    content={i18nService.t('importSkillTooltip')}
                    position="bottom"
                  >
                    <button
                      type="button"
                      onClick={() => setImportPickerOpen(true)}
                      disabled={importing}
                      className={`flex w-full items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-surface border border-border text-secondary hover:bg-surface-raised hover:text-foreground transition-colors sm:w-auto ${
                        importing ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                    >
                      <ArrowUpTrayIcon className="h-4 w-4" />
                      <span>
                        {importing
                          ? i18nService.t('importSkillProgress')
                          : i18nService.t('importSkill')}
                      </span>
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>

            {filteredSkills.length === 0 ? (
              <div className="text-center py-8 text-sm text-secondary">
                {gatewayOffline
                  ? i18nService.t('gatewayOffline')
                  : i18nService.t('noSkillsAvailable')}
              </div>
            ) : (
              <div className="space-y-6">
                {groupedSkills.map(group => (
                  <section key={group.id}>
                    <div className="mb-2.5 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <h3 className="shrink-0 text-sm font-semibold text-foreground">
                            {getGroupLabel(group.id)}
                          </h3>
                          <span className="shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                            {group.skills.length}
                          </span>
                          <p className="min-w-0 truncate text-xs text-secondary">
                            {getGroupDescription(group.id)}
                          </p>
                          {group.priority && (
                            <span className="shrink-0 text-[9px] text-secondary">
                              {i18nService
                                .t('skillGroupPriority')
                                .replace('{priority}', String(group.priority))}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] items-start gap-3">
                      {group.skills.map(skill => (
                        <div
                          key={skill.id}
                          className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary cursor-pointer"
                          onClick={() => setSelectedSkill(skill)}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-7 h-7 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                                <SparklesIcon className="h-4 w-4 text-secondary" />
                              </div>
                              <span className="text-sm font-medium text-foreground truncate">
                                {skill.name}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {/* Status badge */}
                              {renderSkillStatus(skill)}
                              {!readOnly && !gatewayOffline && canDeleteSkill(skill) && (
                                <button
                                  type="button"
                                  title={i18nService.t('deleteSkill')}
                                  onClick={event => {
                                    event.stopPropagation();
                                    handleDeleteClick(skill);
                                  }}
                                  className="rounded-lg p-1 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500"
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              )}
                              {/* Toggle */}
                              <div
                                className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                                  readOnly || gatewayOffline
                                    ? 'opacity-50 cursor-not-allowed'
                                    : 'cursor-pointer'
                                } ${skill.enabled ? 'bg-primary' : 'bg-border'}`}
                                onClick={e => {
                                  e.stopPropagation();
                                  if (!readOnly && !gatewayOffline) handleToggleSkill(skill.id);
                                }}
                              >
                                <div
                                  className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                                    skill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                                  }`}
                                />
                              </div>
                            </div>
                          </div>

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
                            <p
                              className={`text-xs text-secondary line-clamp-2 ${
                                skill.version ? 'mb-2' : ''
                              }`}
                            >
                              {skillService.getLocalizedSkillDescription(
                                skill.id,
                                skill.name,
                                skill.description,
                              )}
                            </p>
                          </Tooltip>

                          {skill.version && (
                            <div className="flex items-center text-[10px] text-secondary">
                              <div className="flex items-center gap-2">
                                <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                                  v{skill.version}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'marketplace' && (
          <SkillMarketplace
            installed={skills.map(skill => ({ id: skill.id, version: skill.version }))}
            readOnly={readOnly}
            onInstalled={async () => {
              const loadedSkills = await skillService.loadSkills();
              dispatch(setSkills(loadedSkills));
            }}
          />
        )}
      </div>

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

            <p className="text-sm text-secondary mb-4">
              {skillService.getLocalizedSkillDescription(
                selectedSkill.id,
                selectedSkill.name,
                selectedSkill.description,
              )}
            </p>

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

            <button
              type="button"
              onClick={() => handleOpenFolder(selectedSkill)}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
              title={i18nService.t('openFolder')}
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
