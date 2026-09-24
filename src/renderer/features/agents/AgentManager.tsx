import './AgentManager.css';

import {
  ArrowPathIcon,
  CheckIcon,
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import {
  type AgentFileName,
  AgentFiles,
  type AgentFileSnapshot,
  type AgentProfileInput,
} from '@shared/agents/agents';
import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { toOpenClawModelRef } from '@/features/models/openclawModelRef';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

import { agentService } from './agentService';

const emptyProfile = (): AgentProfileInput => ({
  name: '',
  description: '',
  icon: '',
  model: '',
  enabled: true,
  isDefault: false,
});
const inputClass =
  'mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50';

export default function AgentManager({
  leaveGuard,
}: {
  leaveGuard: MutableRefObject<(() => boolean) | null>;
}) {
  const roster = useSelector((state: RootState) => state.agent.agents);
  const agents = roster.filter(agent => !agent.deletedAt);
  const models = useSelector((state: RootState) => state.model.availableModels);
  const [profile, setProfile] = useState<AgentProfileInput>(emptyProfile);
  const [original, setOriginal] = useState(() => JSON.stringify(emptyProfile()));
  const [fileName, setFileName] = useState<AgentFileName>('AGENTS.md');
  const [snapshot, setSnapshot] = useState<AgentFileSnapshot | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const initialized = useRef(false);
  const t = (key: string) => i18nService.t(key);
  const profileDirty = JSON.stringify(profile) !== original;
  const fileDirty = snapshot !== null && snapshot.content !== content;
  const dirty = profileDirty || fileDirty;
  const canLeave = () => !busy && (!dirty || window.confirm(t('agentDiscardChanges')));
  useEffect(() => {
    leaveGuard.current = canLeave;
    return () => {
      leaveGuard.current = null;
    };
  });
  useEffect(() => {
    void agentService.loadAgents();
  }, []);
  const selectProfile = (id?: string) => {
    if (!canLeave()) return;
    initialized.current = true;
    const source = agents.find(agent => agent.id === id);
    const next = source
      ? {
          id: source.id,
          name: source.name,
          description: source.description,
          icon: source.icon,
          model: source.id === 'main' ? '' : source.model,
          enabled: source.enabled,
          isDefault: source.isDefault,
        }
      : emptyProfile();
    setFileName('AGENTS.md');
    setReload(value => value + 1);
    setProfile(next);
    setOriginal(JSON.stringify(next));
    setSnapshot(null);
    setContent('');
    setError('');
    setNotice('');
  };
  useEffect(() => {
    if (initialized.current || !agents.length) return;
    initialized.current = true;
    if (!dirty) selectProfile(agents.find(agent => agent.id === 'main')?.id ?? agents[0].id);
    // Initial roster arrival selects once; refreshes must never overwrite an editor draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  const visibleAgents = agents.filter(
    agent =>
      (filter === 'all' || (filter === 'enabled' ? agent.enabled : !agent.enabled)) &&
      `${agent.name} ${agent.description}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const beginDraft = (next: AgentProfileInput) => {
    if (!canLeave()) return;
    initialized.current = true;
    setProfile(next);
    setOriginal(JSON.stringify(emptyProfile()));
    setSnapshot(null);
    setContent('');
    setFileName('AGENTS.md');
    setError('');
    setNotice('');
  };
  const duplicate = () => {
    const source = agents.find(agent => agent.id === profile.id);
    if (!source) return;
    beginDraft({
      ...emptyProfile(),
      name: t('agentCopyName').replace('{name}', source.name).slice(0, 80),
      description: source.description,
      model: source.id === 'main' ? '' : source.model,
    });
  };
  const changeFile = (next: AgentFileName) => {
    if (fileDirty && !window.confirm(t('agentDiscardChanges'))) return;
    setError('');
    setNotice('');
    setFileName(next);
  };
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setContent('');
    if (!profile.id) {
      setLoadingFile(false);
      return;
    }
    setLoadingFile(true);
    void window.electron.agents
      .readFile(profile.id, fileName)
      .then(result => {
        if (cancelled) return;
        if (result.success) {
          setSnapshot(result.value);
          setContent(result.value.content);
        } else setError(result.error);
      })
      .catch(() => {
        if (!cancelled) setError('agentSaveFailed');
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, fileName, reload]);
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.electron.agents.save(profile);
      if (!result.success) {
        setError(result.error);
        return;
      }
      const saved = result.value;
      const next: AgentProfileInput = {
        id: saved.id,
        name: saved.name,
        description: saved.description,
        icon: saved.icon,
        model: saved.id === 'main' ? '' : saved.model,
        enabled: saved.enabled,
        isDefault: saved.isDefault,
      };
      setProfile(next);
      setOriginal(JSON.stringify(next));
      await agentService.loadAgents();
      setNotice('settingsSaved');
    } catch {
      setError('agentSaveFailed');
    } finally {
      setBusy(false);
    }
  };
  const deleteProfile = async () => {
    if (!profile.id || profile.id === 'main' || profile.isDefault || busy) return;
    const savedName = agents.find(agent => agent.id === profile.id)?.name ?? profile.name;
    if (!window.confirm(t('agentDeleteConfirm').replace('{name}', savedName))) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.electron.agents.delete(profile.id);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setProfile(emptyProfile());
      setOriginal(JSON.stringify(emptyProfile()));
      setSnapshot(null);
      setContent('');
      setFileName('AGENTS.md');
      await agentService.loadAgents();
      setNotice('agentDeleted');
    } catch {
      setError('agentDeleteFailed');
    } finally {
      setBusy(false);
    }
  };
  const saveFile = async () => {
    if (!profile.id || !snapshot) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.electron.agents.writeFile(
        profile.id,
        fileName,
        content,
        snapshot,
      );
      if (result.success) {
        setSnapshot(result.value);
        setContent(result.value.content);
        setNotice('settingsSaved');
      } else setError(result.error);
    } catch {
      setError('agentSaveFailed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('agentManager')} className="agent-manager space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <SparklesIcon className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t('agentManager')}</h2>
              <p className="mt-1 text-xs text-secondary">
                {t('agentRosterSummary')
                  .replace('{total}', String(agents.length))
                  .replace('{enabled}', String(agents.filter(agent => agent.enabled).length))}
              </p>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-secondary">
            {t('agentManagerIntro')}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => selectProfile()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" />
          {t('agentCreate')}
        </button>
      </header>
      <div className="agent-manager-layout grid min-w-0 gap-5">
        <nav aria-label={t('agentManager')} className="min-w-0 space-y-3">
          <div className="relative">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-secondary" />
            <input
              type="search"
              aria-label={t('agentSearch')}
              placeholder={t('agentSearch')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <div
            className="flex rounded-lg bg-surface-raised p-1"
            aria-label={t('agentStatusFilter')}
          >
            {(['all', 'enabled', 'disabled'] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs transition ${filter === value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-secondary hover:text-foreground'}`}
              >
                {t(
                  value === 'all'
                    ? 'agentFilterAll'
                    : value === 'enabled'
                      ? 'agentEnabled'
                      : 'agentDisabled',
                )}
              </button>
            ))}
          </div>
          <div className="agent-manager-roster grid max-h-[240px] gap-1.5 overflow-y-auto sm:grid-cols-2">
            {visibleAgents.map(agent => (
              <button
                key={agent.id}
                type="button"
                disabled={busy}
                aria-pressed={profile.id === agent.id}
                onClick={() => selectProfile(agent.id)}
                className={`flex min-w-0 items-start gap-3 rounded-xl border p-3 text-left transition disabled:opacity-50 ${profile.id === agent.id ? 'border-primary/25 bg-primary/5 ring-1 ring-primary/10' : 'border-transparent hover:border-border hover:bg-surface-raised'}`}
              >
                <AgentAvatar name={agent.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {agent.name}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${agent.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`}
                    />
                  </span>
                  <span className="mt-1 block truncate text-xs text-secondary">
                    {agent.id === 'main'
                      ? t('agentMainLabel')
                      : agent.description || t(agent.enabled ? 'agentEnabled' : 'agentDisabled')}
                  </span>
                </span>
              </button>
            ))}
            {!visibleAgents.length && (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-secondary">
                {t('agentNoMatches')}
              </p>
            )}
          </div>
        </nav>
        <div className="min-w-0 space-y-4">
          {error && (
            <p
              role="alert"
              className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400"
            >
              {t(error)}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"
            >
              <CheckIcon className="h-4 w-4" />
              {t(notice)}
            </p>
          )}
          {!profile.id && (
            <div className="rounded-2xl border border-dashed border-primary/25 bg-primary/5 p-4">
              <p className="mb-3 text-xs font-medium text-secondary">{t('agentTemplates')}</p>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map(preset => (
                  <button
                    key={preset.key}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      beginDraft({
                        ...emptyProfile(),
                        name: t(`agentTemplate${preset.key}`),
                        description: t(`agentTemplate${preset.key}Description`),
                      })
                    }
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground transition hover:border-primary/40"
                  >
                    {preset.icon} {t(`agentTemplate${preset.key}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="overflow-hidden rounded-2xl border border-border bg-background">
            <div className="flex items-center gap-3 border-b border-border bg-surface-raised/40 px-5 py-4">
              <AgentAvatar name={profile.name} large />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-semibold text-foreground">
                  {profile.name || t('agentCreate')}
                </h3>
                <p className="mt-1 text-xs text-secondary">
                  {t(
                    profile.id === 'main'
                      ? 'agentMainLabel'
                      : profile.id
                        ? 'agentProfileSettings'
                        : 'agentNewProfile',
                  )}
                </p>
              </div>
              {profile.id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={duplicate}
                  title={t('agentDuplicateHelp')}
                  aria-label={t('agentDuplicate')}
                  className="rounded-lg p-2 text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                >
                  <DocumentDuplicateIcon className="h-4 w-4" />
                </button>
              )}
              {profile.id && profile.id !== 'main' && !profile.isDefault && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void deleteProfile()}
                  aria-label={t('agentDelete')}
                  title={t('agentDelete')}
                  className="rounded-lg p-2 text-secondary hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              )}
            </div>
            <fieldset disabled={busy} className="space-y-5 p-5">
              <label className="block text-xs font-medium text-secondary">
                {t('agentName')}
                <input
                  className={inputClass}
                  maxLength={80}
                  value={profile.name}
                  placeholder={t('agentNamePlaceholder')}
                  onChange={e => setProfile({ ...profile, name: e.target.value })}
                />
              </label>
              <label className="block text-xs font-medium text-secondary">
                {t('agentDescription')}
                <textarea
                  className={inputClass + ' resize-y leading-relaxed'}
                  maxLength={2000}
                  rows={3}
                  value={profile.description}
                  placeholder={t('agentDescriptionPlaceholder')}
                  onChange={e => setProfile({ ...profile, description: e.target.value })}
                />
              </label>
              {profile.id !== 'main' && (
                <label className="block text-xs font-medium text-secondary">
                  {t('agentModel')}
                  <select
                    className={inputClass}
                    value={profile.model}
                    onChange={e => setProfile({ ...profile, model: e.target.value })}
                  >
                    <option value="">{t('agentInheritModel')}</option>
                    {profile.model &&
                      !models.some(model => toOpenClawModelRef(model) === profile.model) && (
                        <option value={profile.model}>{profile.model}</option>
                      )}
                    {models.map(model => (
                      <option key={toOpenClawModelRef(model)} value={toOpenClawModelRef(model)}>
                        {model.name} · {model.provider}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-surface-raised/50 p-3">
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {t('agentEnabled')}
                  </span>
                  <span className="mt-1 block text-xs font-normal text-secondary">
                    {t(profile.id === 'main' ? 'agentMainAlwaysOn' : 'agentEnabledHelp')}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary"
                  aria-label={t('agentEnabled')}
                  checked={profile.enabled}
                  disabled={profile.id === 'main' || profile.isDefault}
                  onChange={e => setProfile({ ...profile, enabled: e.target.checked })}
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <span className="text-xs text-secondary">
                  {t(profileDirty ? 'agentUnsaved' : 'agentSaveWhenIdle')}
                </span>
                <div className="flex gap-2">
                  {profileDirty && (
                    <button
                      type="button"
                      onClick={() => selectProfile(profile.id)}
                      className="rounded-lg px-3 py-2 text-sm text-secondary hover:bg-surface-raised"
                    >
                      {t('agentDiscard')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                    disabled={!profile.name.trim() || (!!profile.id && !profileDirty)}
                    onClick={() => void save()}
                  >
                    {t(busy ? 'saving' : 'save')}
                  </button>
                </div>
              </div>
            </fieldset>
          </div>
          {profile.id ? (
            <div className="overflow-hidden rounded-2xl border border-border bg-background">
              <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{t('agentFiles')}</h3>
                  <p className="mt-1 text-xs text-secondary">{t('agentRulesIntro')}</p>
                </div>
                <button
                  type="button"
                  disabled={busy || loadingFile}
                  title={t('agentReloadFile')}
                  aria-label={t('agentReloadFile')}
                  onClick={() => {
                    if (fileDirty && !window.confirm(t('agentDiscardChanges'))) return;
                    setError('');
                    setNotice('');
                    setReload(value => value + 1);
                  }}
                  className="rounded-lg p-2 text-secondary hover:bg-surface-raised disabled:opacity-40"
                >
                  <ArrowPathIcon className={`h-4 w-4 ${loadingFile ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div
                className="flex gap-1 overflow-x-auto border-b border-border px-5"
                role="tablist"
                aria-label={t('agentFiles')}
              >
                {AgentFiles.map(name => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={fileName === name}
                    disabled={busy || loadingFile}
                    onClick={() => changeFile(name)}
                    className={`shrink-0 border-b-2 px-3 py-2.5 text-xs font-medium ${fileName === name ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-foreground'}`}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <fieldset disabled={busy || loadingFile} className="space-y-3 p-5">
                <div className="flex items-center justify-between gap-2 text-xs text-secondary">
                  <span>{t(FILE_HINTS[fileName])}</span>
                  <span className="shrink-0 tabular-nums">
                    {content.length.toLocaleString()} / 100,000
                  </span>
                </div>
                {loadingFile && (
                  <p role="status" className="text-xs text-secondary">
                    {t('loading')}
                  </p>
                )}
                <textarea
                  aria-label={fileName}
                  className={inputClass + ' min-h-[240px] resize-y font-mono text-xs leading-6'}
                  rows={12}
                  disabled={!snapshot}
                  value={content}
                  maxLength={100000}
                  spellCheck={false}
                  onChange={e => setContent(e.target.value)}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-secondary">
                    {fileDirty ? t('agentUnsaved') : ''}
                  </span>
                  <button
                    type="button"
                    className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-raised disabled:opacity-40"
                    disabled={!snapshot || !fileDirty}
                    onClick={() => void saveFile()}
                  >
                    {t('agentSaveFile')}
                  </button>
                </div>
                {snapshot && (
                  <details className="border-t border-border pt-3 text-xs text-secondary">
                    <summary className="cursor-pointer">{t('agentWorkspaceDetails')}</summary>
                    <p className="mt-2 break-all font-mono">{snapshot.workspace}</p>
                    <p className="mt-2 leading-relaxed">{t('agentFilesHelp')}</p>
                  </details>
                )}
              </fieldset>
            </div>
          ) : (
            <p className="px-1 text-xs text-secondary">{t('agentCreateFirst')}</p>
          )}
        </div>
      </div>
    </section>
  );
}

const PRESETS = [
  { key: 'Research', icon: '🔎' },
  { key: 'Build', icon: '🛠️' },
  { key: 'Review', icon: '🧪' },
  { key: 'Write', icon: '✍️' },
];
const FILE_HINTS: Record<AgentFileName, string> = {
  'AGENTS.md': 'agentRulesHint',
  'SOUL.md': 'agentSoulHint',
  'IDENTITY.md': 'agentIdentityHint',
};
function AgentAvatar({ name, large = false }: { name: string; large?: boolean }) {
  const colors = [
    'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
    'bg-teal-500/10 text-teal-600 dark:text-teal-300',
    'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    'bg-rose-500/10 text-rose-600 dark:text-rose-300',
  ];
  const color =
    colors[Array.from(name).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % colors.length];
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl ${large ? 'h-12 w-12 text-xl' : 'h-10 w-10 text-base'} ${color}`}
    >
      <span className="max-w-full truncate px-1">
        {Array.from(name.trim())[0]?.toLocaleUpperCase() || '✦'}
      </span>
    </span>
  );
}
