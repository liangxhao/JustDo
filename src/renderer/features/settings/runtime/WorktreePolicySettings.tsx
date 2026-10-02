import type { WorktreeSettings } from '@shared/openclaw/worktrees';
import { useCallback, useEffect, useId, useState } from 'react';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

export default function WorktreePolicySettings() {
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

  const accept = useCallback((value: WorktreeSettings) => {
    setSettings(value);
    setRoot(value.root ?? '');
    setAcceleration(value.acceleration);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.electron.openclaw.worktrees.getSettings();
      if (result.success) accept(result.value);
      else setError(t(`worktreeSettingsError_${result.code}`));
    } catch {
      setError(t('worktreeSettingsError_unavailable'));
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    void load();
  }, [load]);

  const chooseDirectory = async () => {
    setChoosing(true);
    try {
      const result = await window.electron.dialog.selectDirectory();
      if (result.success && result.path) {
        setRoot(result.path);
        setSaved(false);
      }
    } catch {
      setError(t('worktreeDirectoryChooseFailed'));
    } finally {
      setChoosing(false);
    }
  };

  const save = async () => {
    if (!settings) return;
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
      setSaving(false);
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
