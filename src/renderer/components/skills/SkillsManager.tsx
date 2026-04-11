import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { XMarkIcon } from '@heroicons/react/24/outline';

import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setSkills } from '../../store/slices/skillSlice';
import { Skill } from '../../types/skill';
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import FolderOpenIcon from '../icons/FolderOpenIcon';
import PencilSquareIcon from '../icons/PencilSquareIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import PuzzleIcon from '../icons/PuzzleIcon';
import SearchIcon from '../icons/SearchIcon';
import TrashIcon from '../icons/TrashIcon';
import Tooltip from '../ui/Tooltip';

type SkillTab = 'installed' | 'marketplace';

interface SkillsManagerProps {
  readOnly?: boolean;
  onCreateByChat?: () => void;
}

const SkillsManager: React.FC<SkillsManagerProps> = ({ readOnly, onCreateByChat }) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [isAddSkillMenuOpen, setIsAddSkillMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SkillTab>('installed');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [isDeletingSkill, setIsDeletingSkill] = useState(false);

  const addSkillMenuRef = useRef<HTMLDivElement>(null);
  const addSkillButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let isActive = true;
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();

    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [dispatch]);

  useEffect(() => {
    if (!isAddSkillMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideMenu = addSkillMenuRef.current?.contains(target);
      const isInsideButton = addSkillButtonRef.current?.contains(target);
      if (!isInsideMenu && !isInsideButton) {
        setIsAddSkillMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAddSkillMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isAddSkillMenuOpen]);

  useEffect(() => {
    const hasOpenDialog = selectedSkill;
    if (!hasOpenDialog) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedSkill) setSelectedSkill(null);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [selectedSkill]);

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

  const handleRequestDeleteSkill = (skill: Skill) => {
    if (skill.isBuiltIn) {
      setSkillActionError(i18nService.t('skillBuiltInCannotDelete'));
      return;
    }
    setSkillActionError('');
    setSkillPendingDelete(skill);
  };

  const handleCancelDeleteSkill = () => {
    if (isDeletingSkill) return;
    setSkillPendingDelete(null);
  };

  const handleConfirmDeleteSkill = async () => {
    if (!skillPendingDelete || isDeletingSkill) return;
    setIsDeletingSkill(true);
    setSkillActionError('');
    const result = await skillService.deleteSkill(skillPendingDelete.id);
    if (!result.success) {
      setSkillActionError(result.error || i18nService.t('skillDeleteFailed'));
      setIsDeletingSkill(false);
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    setIsDeletingSkill(false);
    setSkillPendingDelete(null);
  };

  const handleCreateByChat = () => {
    setIsAddSkillMenuOpen(false);
    const skillCreator = skills.find(s => s.id === 'skill-creator');

    if (!skillCreator) {
      // Not installed → switch to marketplace tab and search
      setActiveTab('marketplace');
      setSkillSearchQuery('skill-creator');
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('skillCreatorNotInstalled') }),
      );
      return;
    }

    if (!skillCreator.enabled) {
      // Installed but disabled → switch to installed tab and search
      setActiveTab('installed');
      setSkillSearchQuery('skill-creator');
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('skillCreatorNotEnabled') }),
      );
      return;
    }

    onCreateByChat?.();
  };

  const handleOpenSkillsFolder = async () => {
    const root = await skillService.getSkillsRoot();
    if (root) {
      window.electron.shell.openPath(root);
    }
    setIsAddSkillMenuOpen(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-secondary">{i18nService.t('skillsDescription')}</p>
      </div>

      {skillActionError && (
        <ErrorMessage message={skillActionError} onClose={() => setSkillActionError('')} />
      )}

      {/* Sticky toolbar: Description + Search + Tabs */}
      <div className="sticky top-0 z-10 bg-claude-bg dark:bg-claude-darkBg pb-4 space-y-4 shadow-sm">
        {/* Search + Add button */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
            <input
              type="text"
              placeholder={i18nService.t('searchSkills')}
              value={skillSearchQuery}
              onChange={e => setSkillSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div className="relative">
            <button
              ref={addSkillButtonRef}
              type="button"
              onClick={() => setIsAddSkillMenuOpen(prev => !prev)}
              className="px-3 py-2 text-sm rounded-xl border transition-colors bg-surface border-border text-foreground hover:bg-surface-raised flex items-center gap-2"
            >
              <PlusCircleIcon className="h-4 w-4" />
              <span>{i18nService.t('addSkill')}</span>
            </button>

            {isAddSkillMenuOpen && (
              <div
                ref={addSkillMenuRef}
                className="absolute right-0 mt-2 w-72 rounded-xl border border-border bg-surface shadow-lg z-50 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={handleOpenSkillsFolder}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors"
                >
                  <FolderOpenIcon className="h-4 w-4 text-secondary" />
                  <span>{i18nService.t('openSkillsFolder')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleCreateByChat}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-foreground hover:bg-surface-raised transition-colors"
                >
                  <PencilSquareIcon className="h-4 w-4 text-secondary" />
                  <span>{i18nService.t('createSkillByChat')}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-border">
          <button
            type="button"
            onClick={() => setActiveTab('installed')}
            className={`px-4 py-2 text-sm font-medium transition-colors relative ${
              activeTab === 'installed'
                ? 'text-foreground'
                : 'text-secondary hover:hover:text-foreground'
            }`}
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
            className={`px-4 py-2 text-sm font-medium transition-colors relative ${
              activeTab === 'marketplace'
                ? 'text-foreground'
                : 'text-secondary hover:hover:text-foreground'
            }`}
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
                  {i18nService.t('noSkillsAvailable')}
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
                        {!readOnly && !skill.isBuiltIn && (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              handleRequestDeleteSkill(skill);
                            }}
                            className="p-1 rounded-lg text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                            title={i18nService.t('deleteSkill')}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        )}
                        <div
                          className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                            readOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                          } ${skill.enabled ? 'bg-primary' : 'bg-border'}`}
                          onClick={e => {
                            e.stopPropagation();
                            if (!readOnly) handleToggleSkill(skill.id);
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
          </div>
        )}
      </div>

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
              {!readOnly && !selectedSkill.isBuiltIn ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSkill(null);
                    handleRequestDeleteSkill(selectedSkill);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl text-red-500 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('deleteSkill')}
                </button>
              ) : (
                <div />
              )}
              <div
                className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                  readOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                } ${selectedSkill.enabled ? 'bg-primary' : 'bg-border'}`}
                onClick={() => {
                  if (readOnly) return;
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
              {i18nService.t('skillDeleteConfirm').replace('{name}', skillPendingDelete.name)}
            </p>
            {skillActionError && (
              <div className="mt-3 text-xs text-red-500">{skillActionError}</div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDeleteSkill}
                disabled={isDeletingSkill}
                className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSkill}
                disabled={isDeletingSkill}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('confirmDelete')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
};

export default SkillsManager;
