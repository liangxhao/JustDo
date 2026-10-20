import {
  ArrowPathIcon,
  ArrowUpRightIcon,
  ChatBubbleLeftRightIcon,
  ChevronDownIcon,
  ShareIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  type AgentTeamKind,
  type AgentTeamOverrides,
  type AgentTeamSettings,
  type AgentTeamSettingsSnapshot,
  type AgentTeamSettingsView,
  defaultAgentTeamSettings,
  effectiveDiscussionDefaults,
  parseAgentTeamSettings,
} from '../../../contracts/agentTeamSettings';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService, Modal, useOwnerDocument } from '../ui';
import { settingsApi } from '../ports';

export const AGENT_TEAM_SETTINGS_CHANGED = 'agent-team:settings-changed';

function ModeSettingsCard({
  kind,
  description,
  children,
}: {
  kind: AgentTeamKind;
  description?: ReactNode;
  children: ReactNode;
}) {
  const collaboration = kind === 'collaboration';
  const Icon = collaboration ? ShareIcon : ChatBubbleLeftRightIcon;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${collaboration ? 'bg-primary-muted text-primary' : 'bg-violet-500/10 text-violet-500'}`}
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {i18nService.t(collaboration ? 'teamTask' : 'teamGroup')}
          </h3>
          {description && <p className="mt-1 text-xs text-secondary">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function AdvancedSettings({ children }: { children: ReactNode }) {
  return (
    <details className="group border-t border-border bg-surface-raised px-4">
      <summary className="flex cursor-pointer list-none items-center justify-between py-2.5 text-xs font-medium text-secondary outline-none transition-colors hover:text-foreground focus-visible:text-primary [&::-webkit-details-marker]:hidden">
        {i18nService.t('agentTeamAdvanced')}
        <ChevronDownIcon
          aria-hidden="true"
          className="h-3.5 w-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}

/** Local form draft: saving never modifies any conversation composer draft. */
export default function AgentTeamSettingsDialog({
  team,
  onClose,
  onOpenRuntime,
}: {
  team?: { kind: AgentTeamKind; roomId: string };
  onClose: () => void;
  onOpenRuntime?: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const [snapshot, setSnapshot] = useState<AgentTeamSettingsSnapshot>();
  const [view, setView] = useState<AgentTeamSettingsView>();
  const [value, setValue] = useState<AgentTeamSettings>(defaultAgentTeamSettings);
  const [overrides, setOverrides] = useState<AgentTeamOverrides>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const form = useRef<HTMLDivElement>(null);
  const t = i18nService.t.bind(i18nService);
  const teamKind = team?.kind;
  const roomId = team?.roomId;
  useEffect(() => {
    let live = true;
    setSnapshot(undefined);
    setView(undefined);
    const api = settingsApi;
    if (!api) {
      setError('agentTeamSettingsUnavailable');
      return;
    }
    const load = async () => {
      if (teamKind && roomId) {
        const result = await api.readTeam(teamKind, roomId);
        if (!live) return;
        if (!result.success) throw new Error(result.error);
        setView(result.value);
        setSnapshot(result.value.global);
        setValue(result.value.global.value);
        setOverrides(result.value.team.value);
      } else {
        const result = await api.read();
        if (!live) return;
        if (!result.success) throw new Error(result.error);
        setSnapshot(result.value);
        setValue(result.value.value);
      }
    };
    void load().catch(e => {
      if (live) setError(e instanceof Error ? e.message : 'agentTeamSettingsUnavailable');
    });
    return () => {
      live = false;
    };
  }, [teamKind, roomId]);
  useEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null;
    form.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [ownerDocument]);
  const close = () => {
    if (!savingRef.current) onClose();
  };
  const numberField = (
    key: string,
    current: number | null | undefined,
    min: number,
    max: number,
    change: (value: number | null) => void,
    empty?: string,
    effective?: number,
  ) => (
    <label
      className="flex min-h-11 items-center justify-between gap-3 border-b border-border-subtle py-1.5 text-sm last:border-b-0"
      key={key}
    >
      <span className="min-w-0 leading-5 text-foreground">
        {t(key)}
        {effective !== undefined && (
          <span className="block text-xs text-secondary">
            {t('agentTeamEffective')}: {effective}
          </span>
        )}
      </span>
      <span className={`relative shrink-0 ${team ? 'w-32 sm:w-40' : 'w-24'}`}>
        <select
          aria-label={t(key)}
          value={current ?? ''}
          disabled={saving}
          className="h-8 w-full appearance-none rounded-lg border border-border bg-surface py-1 pl-3 pr-8 text-sm tabular-nums text-foreground outline-none transition-colors hover:border-primary focus:border-primary focus:ring-2 focus:ring-primary-muted disabled:opacity-50"
          onChange={e => change(e.target.value === '' ? null : Number(e.target.value))}
        >
          {empty && <option value="">{t(empty)}</option>}
          {current !== null && current !== undefined && current > max && (
            <option value={current} disabled>
              {current}
            </option>
          )}
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map(n => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-secondary"
        />
      </span>
    </label>
  );
  const c = value.collaboration;
  const d = value.discussion;
  const changeDiscussion = (
    key: keyof AgentTeamSettings['discussion'],
    next: number | null | boolean,
  ) => setValue(current => ({ ...current, discussion: { ...current.discussion, [key]: next } }));
  const changeOverride = (key: keyof AgentTeamOverrides, next: number | null) => {
    setOverrides(current => {
      const result = { ...current };
      if (next === null) delete result[key];
      else result[key] = next;
      return result;
    });
  };
  const effective = effectiveDiscussionDefaults(value, overrides);
  const save = async () => {
    if (!snapshot || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (team && view) {
        const result = await settingsApi.saveTeam(
          team.kind,
          team.roomId,
          overrides,
          view.team.revision,
        );
        if (!result.success) throw new Error(result.error);
      } else {
        const parsed = parseAgentTeamSettings(value);
        const result = await settingsApi.save(parsed, snapshot.revision);
        if (!result.success) throw new Error(result.error);
      }
      window.dispatchEvent(new CustomEvent(AGENT_TEAM_SETTINGS_CHANGED));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'agentTeamSettingsInvalid');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return createPortal(
    <Modal
      onClose={close}
      closeOnBackdrop={!saving}
      className="mx-4 w-full max-w-[540px] overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl"
    >
      <div
        ref={form}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-team-settings-title"
        aria-describedby="agent-team-settings-description"
        className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none"
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
          if (e.key === 'Tab') {
            const fields = Array.from(
              form.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),select:not(:disabled),input:not(:disabled),summary',
              ) ?? [],
            ).filter(field => {
              const collapsed = field.closest('details:not([open])');
              return !collapsed || collapsed.querySelector('summary') === field;
            });
            if (!fields.length) {
              e.preventDefault();
              return;
            }
            const first = fields[0];
            const last = fields[fields.length - 1];
            if (
              e.shiftKey &&
              (ownerDocument.activeElement === first ||
                ownerDocument.activeElement === form.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (
              !e.shiftKey &&
              (ownerDocument.activeElement === last || ownerDocument.activeElement === form.current)
            ) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-muted text-primary">
            <UserGroupIcon aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="agent-team-settings-title" className="text-base font-semibold leading-6">
              {t(team ? 'agentTeamLocalSettings' : 'agentTeamSettings')}
            </h2>
            <p
              id="agent-team-settings-description"
              className="mt-1 text-xs leading-5 text-secondary"
            >
              {t(team ? 'agentTeamNextBatch' : 'agentTeamDefaultsHelp')}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            disabled={saving}
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            onClick={close}
          >
            <XMarkIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain bg-background px-5 py-4">
          {!snapshot && !error && (
            <p className="py-6 text-center text-sm text-secondary">{t('loading')}</p>
          )}
          {snapshot &&
            (team ? (
              <ModeSettingsCard
                kind={team.kind}
                description={
                  <>
                    {t('agentTeamMembers')}: {view?.memberCount} · {t('agentTeamMemberLimit')}:{' '}
                    {team.kind === 'collaboration' ? c.maxMembers : d.maxMembers}
                  </>
                }
              >
                <div className="px-4 pb-3">
                  {team.kind === 'collaboration' ? (
                    <>
                      {numberField(
                        'agentTeamMessageBudget',
                        overrides.messageBudget,
                        4,
                        c.messageBudget,
                        n => changeOverride('messageBudget', n),
                        'agentTeamInherit',
                        Math.min(overrides.messageBudget ?? c.messageBudget, c.messageBudget),
                      )}
                      <p className="mt-2 text-xs leading-5 text-secondary">
                        {t('agentTeamBudgetHelp')}
                      </p>
                    </>
                  ) : (
                    <>
                      {numberField(
                        'agentTeamDefaultRounds',
                        overrides.defaultRounds,
                        1,
                        d.maxRounds,
                        n => changeOverride('defaultRounds', n),
                        'agentTeamInherit',
                        effective.defaultRounds,
                      )}
                      {numberField(
                        'agentTeamConcurrency',
                        overrides.maxConcurrent,
                        1,
                        d.maxConcurrent ?? 6,
                        n => changeOverride('maxConcurrent', n),
                        'agentTeamInherit',
                        Math.min(effective.maxConcurrent, view?.memberCount ?? 6),
                      )}
                      {numberField(
                        'agentTeamTurns',
                        overrides.maxTurns,
                        1,
                        d.maxTurns ?? 24,
                        n => changeOverride('maxTurns', n),
                        'agentTeamInherit',
                        Math.min(
                          effective.maxTurns,
                          (view?.memberCount ?? 6) * effective.defaultRounds,
                        ),
                      )}
                    </>
                  )}
                </div>
              </ModeSettingsCard>
            ) : (
              <>
                <ModeSettingsCard kind="collaboration">
                  <div className="px-4 pb-1">
                    {numberField('agentTeamMemberLimit', c.maxMembers, 2, 12, n =>
                      setValue(current => ({
                        ...current,
                        collaboration: { ...current.collaboration, maxMembers: n! },
                      })),
                    )}
                  </div>
                  <AdvancedSettings>
                    {numberField('agentTeamMessageBudget', c.messageBudget, 4, 16, n =>
                      setValue(current => ({
                        ...current,
                        collaboration: { ...current.collaboration, messageBudget: n! },
                      })),
                    )}
                    <p className="mt-1 text-xs leading-5 text-secondary">
                      {t('agentTeamBudgetHelp')}
                    </p>
                  </AdvancedSettings>
                </ModeSettingsCard>
                <ModeSettingsCard kind="discussion">
                  <div className="px-4 pb-1">
                    {numberField('agentTeamMemberLimit', d.maxMembers, 2, 6, n =>
                      changeDiscussion('maxMembers', n),
                    )}
                    {numberField('agentTeamDefaultRounds', d.defaultRounds, 1, 4, n =>
                      changeDiscussion('defaultRounds', n),
                    )}
                    {numberField(
                      'agentTeamConcurrency',
                      d.maxConcurrent,
                      1,
                      6,
                      n => changeDiscussion('maxConcurrent', n),
                      'agentTeamAuto',
                    )}
                    <div className="flex min-h-11 items-center justify-between gap-3 py-1.5 text-sm">
                      <span>{t('agentTeamOrganizerDefault')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-label={t('agentTeamOrganizerDefault')}
                        aria-checked={d.organizerParticipates}
                        disabled={saving}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 ${d.organizerParticipates ? 'bg-primary' : 'bg-border-input'}`}
                        onClick={() =>
                          changeDiscussion('organizerParticipates', !d.organizerParticipates)
                        }
                      >
                        <span
                          className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${d.organizerParticipates ? 'translate-x-4' : 'translate-x-0'}`}
                        />
                      </button>
                    </div>
                  </div>
                  <AdvancedSettings>
                    {numberField(
                      'agentTeamTurns',
                      d.maxTurns,
                      1,
                      24,
                      n => changeDiscussion('maxTurns', n),
                      'agentTeamAuto',
                    )}
                    {numberField('agentTeamMaxRounds', d.maxRounds, 1, 4, n =>
                      changeDiscussion('maxRounds', n),
                    )}
                    <p className="mt-1 text-xs leading-5 text-secondary">
                      {t('agentTeamTurnsHelp')}
                    </p>
                  </AdvancedSettings>
                </ModeSettingsCard>
                {onOpenRuntime && (
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-xs text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                    disabled={saving}
                    onClick={() => {
                      onClose();
                      onOpenRuntime();
                    }}
                  >
                    {t('agentTeamRuntimeLink')}
                    <ArrowUpRightIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  </button>
                )}
              </>
            ))}
        </div>
        {error && (
          <p
            role="alert"
            className="mx-5 my-3 shrink-0 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-500"
          >
            {t(error)}
          </p>
        )}
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            title={t(team ? 'agentTeamResetInherit' : 'agentTeamReset')}
            disabled={!snapshot || saving}
            className="mr-auto inline-flex min-w-0 items-center gap-1.5 rounded-lg py-2 pr-2 text-xs text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            onClick={() => {
              if (team) setOverrides({});
              else setValue(defaultAgentTeamSettings());
              setError('');
            }}
          >
            <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t(team ? 'agentTeamResetInherit' : 'agentTeamReset')}</span>
          </button>
          <button
            type="button"
            disabled={saving}
            className="shrink-0 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            onClick={close}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            disabled={!snapshot || saving}
            className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
            onClick={() => void save()}
          >
            {t('save')}
          </button>
        </footer>
      </div>
    </Modal>,
    ownerDocument.body,
  );
}
