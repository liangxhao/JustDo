import { ComputerDesktopIcon } from '@heroicons/react/24/outline';
import { OpenClawExtensionId } from '@shared/openclaw/extensions';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

export default function ComputerControlSettingsPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const active = useRef(true);
  const invalidate = useCallback(() => {
    ++revision.current;
  }, []);

  const load = useCallback(async (clearError = true) => {
    const request = ++revision.current;
    if (clearError) setError(null);
    try {
      const result = await window.electron.openclaw.computerControl.get();
      if (!active.current || request !== revision.current) return;
      if (result.success) setEnabled(result.enabled);
      else {
        setEnabled(null);
        setError(t('computerControlLoadFailed'));
      }
    } catch {
      if (active.current && request === revision.current) {
        setEnabled(null);
        setError(t('computerControlLoadFailed'));
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    const refresh = () => {
      void load();
    };
    const stop = window.electron.extensions.onChanged(change => {
      if (change.extensionId === OpenClawExtensionId.CUA_COMPUTER) refresh();
    });
    window.addEventListener('focus', refresh);
    void load();
    return () => {
      active.current = false;
      invalidate();
      stop();
      window.removeEventListener('focus', refresh);
    };
  }, [invalidate, load]);

  const toggle = async () => {
    if (enabled === null || saving) return;
    const desired = !enabled;
    ++revision.current;
    setSaving(true);
    setError(null);
    try {
      const result = await window.electron.openclaw.computerControl.setEnabled(desired);
      if (!active.current) return;
      if (result.success) setEnabled(result.enabled);
      else setError(t('computerControlSaveFailed'));
    } catch {
      if (active.current) setError(t('computerControlSaveFailed'));
    } finally {
      if (active.current) {
        // An apply error can follow a committed write; show the observed choice.
        await load(false);
        setSaving(false);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-2xl border border-border bg-surface-raised/50 p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ComputerDesktopIcon aria-hidden="true" className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div id="computer-control-label" className="text-sm font-semibold text-foreground">
            {t('computerControlEnable')}
          </div>
          <p id="computer-control-description" className="mt-1 text-xs leading-5 text-secondary">
            {t('computerControlEnableDescription')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby="computer-control-label"
          aria-describedby="computer-control-description"
          aria-checked={enabled === true}
          aria-busy={saving}
          disabled={enabled === null || saving}
          onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-border'}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
          />
        </button>
      </div>
      <p className="text-sm leading-6 text-secondary">{t('computerControlModelRequirement')}</p>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={saving}
            className="shrink-0 underline disabled:opacity-50"
          >
            {t('retry')}
          </button>
        </div>
      )}
    </div>
  );
}
