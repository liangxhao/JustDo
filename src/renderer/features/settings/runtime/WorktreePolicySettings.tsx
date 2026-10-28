import type { WorktreeSettings } from '@shared/openclaw/worktrees';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useEngineReadiness } from '@/app/shell/startup/routing/useEngineReadiness';
import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

export default function WorktreePolicySettings() {
  const engine = useEngineReadiness();
  const engineReady = useRef(engine.ready);
  engineReady.current = engine.ready;
  const active = useRef(true);
  const readGeneration = useRef(0);
  const mutationPending = useRef(false);
  const refreshPending = useRef(false);
  const readFailed = useRef(false);
  const dirty = useRef(false);
  const rootId = useId();
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [root, setRoot] = useState('');
  const [acceleration, setAcceleration] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = loading || saving || choosing;
  dirty.current = Boolean(settings &&
    ((root.trim() || null) !== settings.root || acceleration !== settings.acceleration));

  const accept = useCallback((value: WorktreeSettings) => {
    setSettings(value);
    setRoot(value.root ?? '');
    setAcceleration(value.acceleration);
  }, []);

  const load = useCallback(async (preserveDraft = false) => {
    if (!active.current) return;
    if (!engineReady.current || mutationPending.current) {
      refreshPending.current = true;
      return;
    }
    refreshPending.current = false;
    const generation = ++readGeneration.current;
    if (!preserveDraft) {
      setLoading(true);
      setError(null);
      setSaved(false);
    }
    const isCurrent = () => active.current && engineReady.current &&
      generation === readGeneration.current;
    try {
      const result = await window.electron.openclaw.worktrees.getSettings();
      if (!isCurrent()) return;
      if (result.success) {
        // Retain the original CAS baseline with dirty drafts; recovery cannot rebase a write.
        if (!preserveDraft || !dirty.current) accept(result.value);
        if (readFailed.current) setError(null);
        readFailed.current = false;
      } else {
        readFailed.current = true;
        setError(t(`worktreeSettingsError_${result.code}`));
      }
    } catch {
      if (!isCurrent()) return;
      readFailed.current = true;
      setError(t('worktreeSettingsError_unavailable'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    active.current = true;
    if (engine.ready) void load(true);
    else {
      readGeneration.current += 1;
      refreshPending.current = true;
    }
    return () => {
      active.current = false;
      readGeneration.current += 1;
    };
  }, [engine.ready, load]);

  const chooseDirectory = async () => {
    if (!engineReady.current || mutationPending.current) return;
    mutationPending.current = true;
    readGeneration.current += 1;
    setChoosing(true);
    try {
      const result = await window.electron.dialog.selectDirectory();
      if (result.success && result.path) {
        dirty.current = true;
        setRoot(result.path);
        setSaved(false);
      }
    } catch {
      readFailed.current = false;
      setError(t('worktreeDirectoryChooseFailed'));
    } finally {
      mutationPending.current = false;
      setChoosing(false);
      if (refreshPending.current) void load(true);
    }
  };

  const save = async () => {
    if (!engineReady.current || mutationPending.current || !settings) return;
    mutationPending.current = true;
    readGeneration.current += 1;
    readFailed.current = false;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.electron.openclaw.worktrees.saveSettings({
        root: root.trim() || null,
        acceleration,
        revision: settings.revision,
      });
      if (result.success) {
        accept(result.value);
        setSaved(true);
      } else {
        setError(t(`worktreeSettingsError_${result.code}`));
      }
    } catch {
      setError(t('worktreeSettingsError_unavailable'));
    } finally {
      mutationPending.current = false;
      setSaving(false);
      if (refreshPending.current) void load(true);
    }
  };

  const changed =
    settings && ((root.trim() || null) !== settings.root || acceleration !== settings.acceleration);
  const buttonClass =
    'rounded-lg border border-border px-3 py-2 text-sm text-foreground disabled:opacity-50';

  return (
    <section
      aria-label={t('worktreePolicyTitle')}
      className="rounded-xl border border-border bg-surface"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('worktreePolicyTitle')}</h3>
          <p className="mt-1 text-xs leading-5 text-secondary">{t('worktreePolicyDescription')}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy} className={buttonClass}>
          {t('worktreeReloadSettings')}
        </button>
      </div>
      {error && (
        <p role="alert" className="mx-5 mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {loading ? (
        <p className="p-5 text-sm text-secondary">{t('worktreeSettingsLoading')}</p>
      ) : (
        settings && (
          <div className="space-y-5 p-5">
            <div>
              <label htmlFor={rootId} className="text-sm font-medium text-foreground">
                {t('worktreeStorageRoot')}
              </label>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {t('worktreeStorageRootDescription')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  id={rootId}
                  type="text"
                  value={root}
                  disabled={busy}
                  onChange={event => {
                    setRoot(event.target.value);
                    setSaved(false);
                  }}
                  placeholder={t('worktreeStorageRootDefault')}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface-inset px-3 py-2 text-sm text-foreground"
                />
                <button
                  type="button"
                  onClick={() => void chooseDirectory()}
                  disabled={busy}
                  className={buttonClass}
                >
                  {t('worktreeChooseDirectory')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRoot('');
                    setSaved(false);
                  }}
                  disabled={busy || !root}
                  className={buttonClass}
                >
                  {t('worktreeUseDefaultRoot')}
                </button>
              </div>
              <p className="mt-2 break-all text-xs text-secondary">
                {t(settings.applied ? 'worktreeEffectiveRoot' : 'worktreeConfiguredRoot')}:{' '}
                {settings.effectiveRoot}
              </p>
            </div>
            <label className="flex items-start justify-between gap-4 border-t border-border pt-5">
              <span>
                <span className="block text-sm font-medium text-foreground">
                  {t('worktreeAcceleration')}
                </span>
                <span className="mt-1 block text-xs leading-5 text-secondary">
                  {t('worktreeAccelerationDescription')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={acceleration}
                disabled={busy}
                onChange={event => {
                  setAcceleration(event.target.checked);
                  setSaved(false);
                }}
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p
                role="status"
                className={`text-xs ${settings.applied ? 'text-secondary' : 'text-amber-600'}`}
              >
                {t(
                  changed
                    ? 'worktreeSettingsUnsaved'
                    : !settings.applied
                      ? 'worktreeSettingsPending'
                      : saved
                        ? 'worktreeSettingsSaved'
                        : 'worktreeSettingsApplied',
                )}
              </p>
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !changed}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {t(saving ? 'worktreeSettingsSaving' : 'worktreeSaveSettings')}
              </button>
            </div>
          </div>
        )
      )}
    </section>
  );
}
