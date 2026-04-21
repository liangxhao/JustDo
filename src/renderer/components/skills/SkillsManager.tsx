import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { ArrowUpTrayIcon, FolderIcon, XMarkIcon } from '@heroicons/react/24/outline';

import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setSkills } from '../../store/slices/skillSlice';
import { Skill } from '../../types/skill';
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import PuzzleIcon from '../icons/PuzzleIcon';
import SearchIcon from '../icons/SearchIcon';
import TrashIcon from '../icons/TrashIcon';
import Tooltip from '../ui/Tooltip';

type SkillTab = 'installed' | 'marketplace';

interface SkillsManagerProps {
  readOnly?: boolean;
  onCreateByChat?: () => void;
}

const SkillsManager: React.FC<SkillsManagerProps> = ({ readOnly }) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [activeTab, setActiveTab] = useState<SkillTab>('installed');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<{ fileName: string; error: string }[]>([]);

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

    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
      setGatewayOffline(skillService.isGatewayOffline());
    });

    return () => {
      isActive = false;
      unsubscribe();
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

  const formatSkillDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  };

  const handleToggleSkill = async (skillId: string) => {
    if (gatewayOffline) {
      setSkillActionError(i18nService.t('gatewayOffline'));
      return;
    }
    const targetSkill = skills.find(skill => skill.id === skillId);
    if (!targetSkill) return;
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, !targetSkill.enabled);
      dispatch(setSkills(updatedSkills));
      setSkillActionError('');
    } catch (error) {
      setSkillActionError(
        error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'),
      );
    }
  };

  const handleImportSkill = async () => {
    if (readOnly || importing) return;

    try {
      setImporting(true);
      setSkillActionError('');
      setImportSuccess(null);
      setImportErrors([]);

      // Open file dialog for ZIP/TGZ archives (multi-select)
      const result = await window.electron.dialog.selectFiles({
        title: i18nService.t('selectSkillArchive'),
        filters: [
          { name: 'Skill Archives', extensions: ['zip', 'tgz', 'tar.gz'] },
          { name: 'ZIP Files', extensions: ['zip'] },
          { name: 'TGZ Files', extensions: ['tgz', 'tar.gz'] },
        ],
      });

      if (!result.success || !result.paths || result.paths.length === 0) {
        setImporting(false);
        return;
      }

      // Import each skill
      const results: { path: string; success: boolean; skillId?: string; error?: string }[] = [];
      for (const archivePath of result.paths) {
        const importResult = await skillService.importSkill(archivePath);
        results.push({
          path: archivePath,
          success: importResult.success,
          skillId: importResult.skillId,
          error: importResult.error,
        });
      }

      // Check results
      const succeeded = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      if (succeeded.length > 0) {
        const skillIds = succeeded
          .map(r => r.skillId)
          .filter(Boolean)
          .join(', ');
        setImportSuccess(skillIds);
        // Reload skills
        const loadedSkills = await skillService.loadSkills();
        dispatch(setSkills(loadedSkills));
        // Clear success message after 5 seconds
        setTimeout(() => setImportSuccess(null), 5000);
      }

      if (failed.length > 0) {
        setImportErrors(
          failed.map(r => ({
            fileName: r.path.split(/[/\\]/).pop() || r.path,
            error: r.error || i18nService.t('skillImportFailed'),
          })),
        );
      }
    } catch (error) {
      setSkillActionError(
        error instanceof Error ? error.message : i18nService.t('skillImportFailed'),
      );
    } finally {
      setImporting(false);
    }
  };

  const handleImportSkillFromFolder = async () => {
    if (readOnly || importing) return;

    try {
      setImporting(true);
      setSkillActionError('');
      setImportSuccess(null);
      setImportErrors([]);

      // Open folder dialog for skill folders (multi-select)
      const result = await window.electron.dialog.selectFolders({
        title: i18nService.t('selectSkillFolder'),
      });

      if (!result.success || !result.paths || result.paths.length === 0) {
        setImporting(false);
        return;
      }

      // Import each skill folder
      const results: { path: string; success: boolean; skillId?: string; error?: string }[] = [];
      for (const folderPath of result.paths) {
        const importResult = await skillService.importSkillFromFolder(folderPath);
        results.push({
          path: folderPath,
          success: importResult.success,
          skillId: importResult.skillId,
          error: importResult.error,
        });
      }

      // Check results
      const succeeded = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      if (succeeded.length > 0) {
        const skillIds = succeeded
          .map(r => r.skillId)
          .filter(Boolean)
          .join(', ');
        setImportSuccess(skillIds);
        // Reload skills
        const loadedSkills = await skillService.loadSkills();
        dispatch(setSkills(loadedSkills));
        // Clear success message after 5 seconds
        setTimeout(() => setImportSuccess(null), 5000);
      }

      if (failed.length > 0) {
        setImportErrors(
          failed.map(r => ({
            fileName: r.path.split(/[/\\]/).pop() || r.path,
            error: r.error || i18nService.t('skillImportFailed'),
          })),
        );
      }
    } catch (error) {
      setSkillActionError(
        error instanceof Error ? error.message : i18nService.t('skillImportFailed'),
      );
    } finally {
      setImporting(false);
    }
  };

  // Skill deletion not supported - handled via error message
  const handleCancelDeleteSkill = () => {
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
    setSkillPendingDelete(skill);
  };

  const handleConfirmDelete = async () => {
    if (!skillPendingDelete) return;

    // If built-in skill, show manual delete hint and open folder
    if (skillPendingDelete.isBuiltIn) {
      const skillPath = skillPendingDelete.skillPath;
      const lastSep = Math.max(skillPath.lastIndexOf('/'), skillPath.lastIndexOf('\\'));
      const skillDir = lastSep >= 0 ? skillPath.substring(0, lastSep) : skillPath;
      await window.electron.shell.openPath(skillDir);
      setSkillActionError(i18nService.t('skillBuiltInDeleteHint'));
      setSkillPendingDelete(null);
      return;
    }

    // Try to delete managed skill
    const result = await skillService.deleteSkill(skillPendingDelete.id);
    if (result.success && result.skills) {
      dispatch(setSkills(result.skills));
    } else {
      // If delete failed (non-managed), show manual delete hint and open folder
      if (result.error?.includes('not found')) {
        const skillPath = skillPendingDelete.skillPath;
        const lastSep = Math.max(skillPath.lastIndexOf('/'), skillPath.lastIndexOf('\\'));
        const skillDir = lastSep >= 0 ? skillPath.substring(0, lastSep) : skillPath;
        await window.electron.shell.openPath(skillDir);
        setSkillActionError(i18nService.t('skillDeleteManualHint'));
      } else {
        setSkillActionError(result.error || i18nService.t('skillDeleteFailed'));
      }
    }
    setSkillPendingDelete(null);
  };

  // Render skill eligibility status
  const renderSkillStatus = (skill: Skill) => {
    if (skill.eligible === false) {
      const missingBins = skill.missing?.bins || [];
      const missingEnv = skill.missing?.env || [];
      const missingCount = missingBins.length + missingEnv.length;
      if (missingCount > 0) {
        return (
          <Tooltip
            content={`${i18nService.t('skillMissingRequirements')}: ${missingBins.join(', ')} ${missingEnv.join(', ')}`}
            position="bottom"
            maxWidth="360px"
          >
            <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600 text-[10px] font-medium">
              {missingCount} {i18nService.t('missing')}
            </span>
          </Tooltip>
        );
      }
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

      <div>
        <p className="text-sm text-secondary">{i18nService.t('skillsDescriptionGateway')}</p>
      </div>

      {skillActionError && (
        <ErrorMessage message={skillActionError} onClose={() => setSkillActionError('')} />
      )}

      {importErrors.length > 0 && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium">{i18nService.t('skillImportFailed')}</span>
            <button
              type="button"
              onClick={() => setImportErrors([])}
              className="p-1 rounded hover:bg-red-500/20 transition-colors"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <ul className="list-disc list-inside space-y-1 text-xs">
            {importErrors.map((err, idx) => (
              <li key={idx}>
                <span className="font-medium">{err.fileName}:</span> {err.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {importSuccess && (
        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/30 text-green-600 text-sm">
          {i18nService.t('skillImportSuccess').replace('{skillId}', importSuccess)}
        </div>
      )}

      {/* Sticky toolbar: Description + Search + Tabs */}
      <div className="sticky top-0 z-10 bg-claude-bg dark:bg-claude-darkBg pb-4 space-y-4 shadow-sm">
        {/* Search */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              type="text"
              placeholder={i18nService.t('searchSkills')}
              value={skillSearchQuery}
              onChange={e => setSkillSearchQuery(e.target.value)}
              disabled={gatewayOffline && activeTab === 'installed'}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
          {/* Import buttons - only show in installed tab and when not readonly */}
          {activeTab === 'installed' && !readOnly && !gatewayOffline && (
            <>
              <Tooltip content={i18nService.t('importSkillTooltip')} position="bottom">
                <button
                  type="button"
                  onClick={handleImportSkill}
                  disabled={importing}
                  className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-surface border border-border text-secondary hover:bg-surface-raised hover:text-foreground transition-colors ${
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
              <Tooltip content={i18nService.t('importSkillFolderTooltip')} position="bottom">
                <button
                  type="button"
                  onClick={handleImportSkillFromFolder}
                  disabled={importing}
                  className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-surface border border-border text-secondary hover:bg-surface-raised hover:text-foreground transition-colors ${
                    importing ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  <FolderIcon className="h-4 w-4" />
                  <span>
                    {importing
                      ? i18nService.t('importSkillFolderProgress')
                      : i18nService.t('importSkillFolder')}
                  </span>
                </button>
              </Tooltip>
            </>
          )}
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-border">
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
      </div>

      <div>
        {activeTab === 'installed' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {filteredSkills.length === 0 ? (
                <div className="col-span-2 text-center py-8 text-sm text-secondary">
                  {gatewayOffline
                    ? i18nService.t('gatewayOffline')
                    : i18nService.t('noSkillsAvailable')}
                </div>
              ) : (
                filteredSkills.map(skill => (
                  <div
                    key={skill.id}
                    className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary cursor-pointer"
                    onClick={() => setSelectedSkill(skill)}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-7 h-7 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                          <PuzzleIcon className="h-4 w-4 text-secondary" />
                        </div>
                        <span className="text-sm font-medium text-foreground truncate">
                          {skill.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Status badge */}
                        {renderSkillStatus(skill)}
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
                      <p className="text-xs text-secondary line-clamp-2 mb-2">
                        {skillService.getLocalizedSkillDescription(
                          skill.id,
                          skill.name,
                          skill.description,
                        )}
                      </p>
                    </Tooltip>

                    <div className="flex items-center justify-between text-[10px] text-secondary">
                      <div className="flex items-center gap-2">
                        {skill.isOfficial && (
                          <>
                            <span className="px-1.5 py-0.5 rounded bg-primary-muted text-primary font-medium">
                              {i18nService.t('official')}
                            </span>
                            <span>·</span>
                          </>
                        )}
                        {skill.version && (
                          <>
                            <span className="px-1.5 py-0.5 rounded bg-surface-raised font-medium">
                              v{skill.version}
                            </span>
                            <span>·</span>
                          </>
                        )}
                        <span>{formatSkillDate(skill.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {activeTab === 'marketplace' && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 mb-4 rounded-2xl bg-surface flex items-center justify-center">
              <PuzzleIcon className="h-8 w-8 text-secondary" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              {i18nService.t('skillMarketplaceComingSoon')}
            </h3>
            <p className="text-sm text-secondary max-w-md">
              {i18nService.t('skillMarketplaceComingSoonDesc')}
            </p>
          </div>
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
                  <PuzzleIcon className="h-5 w-5 text-secondary" />
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
            {selectedSkill.eligible === false && selectedSkill.missing && (
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
              </div>
            )}

            <div className="space-y-2 mb-5">
              {selectedSkill.isOfficial && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 text-secondary">
                    {i18nService.t('skillDetailSource')}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-primary-muted text-primary font-medium">
                    {i18nService.t('official')}
                  </span>
                </div>
              )}
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

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleOpenFolder(selectedSkill)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                  title={i18nService.t('openFolder')}
                >
                  <FolderIcon className="h-3.5 w-3.5" />
                  {i18nService.t('openFolder')}
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteClick(selectedSkill)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                  title={i18nService.t('delete')}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  {i18nService.t('delete')}
                </button>
              </div>
              <div
                className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                  readOnly || gatewayOffline ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                } ${selectedSkill.enabled ? 'bg-primary' : 'bg-border'}`}
                onClick={() => {
                  if (readOnly || gatewayOffline) return;
                  handleToggleSkill(selectedSkill.id);
                  setSelectedSkill({ ...selectedSkill, enabled: !selectedSkill.enabled });
                }}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                    selectedSkill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                  }`}
                />
              </div>
            </div>
          </Modal>,
          document.body,
        )}

      {skillPendingDelete &&
        createPortal(
          <Modal
            onClose={handleCancelDeleteSkill}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('deleteSkill')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {skillPendingDelete.isBuiltIn
                ? i18nService.t('skillBuiltInDeleteHint')
                : i18nService.t('skillDeleteConfirm').replace('{name}', skillPendingDelete.name)}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDeleteSkill}
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  skillPendingDelete.isBuiltIn
                    ? 'bg-surface-raised text-foreground hover:bg-border'
                    : 'bg-red-500 text-white hover:bg-red-600'
                }`}
              >
                {skillPendingDelete.isBuiltIn
                  ? i18nService.t('openFolder')
                  : i18nService.t('delete')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
};

export default SkillsManager;
