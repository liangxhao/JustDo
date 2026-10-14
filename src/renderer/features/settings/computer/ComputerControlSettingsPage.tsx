import { ComputerDesktopIcon } from '@heroicons/react/24/outline';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { ComputerOverlayPreviewSetting } from './ComputerOverlayPreviewSetting';

const t = (key: string) => i18nService.t(key);

export default function ComputerControlSettingsPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const refreshPending = useRef(false);
  const revision = useRef(0);
  const active = useRef(true);
  const invalidate = useCallback(() => {
    ++revision.current;
  }, []);

  const load = useCallback(async (clearError = true) => {
    if (savingRef.current) {
      refreshPending.current = true;
      return;
    }
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
    if (enabled === null || saving || savingRef.current) return;
    const desired = !enabled;
    const request = ++revision.current;
    savingRef.current = true;
    refreshPending.current = false;
    setSaving(true);
    setError(null);
    let reload = false;
    try {
      const result = await window.electron.openclaw.computerControl.setEnabled(desired);
      if (!active.current || request !== revision.current) return;
      if (result.success) setEnabled(result.enabled);
      else {
        reload = true;
        setError(t('computerControlSaveFailed'));
      }
    } catch {
      reload = true;
      if (active.current && request === revision.current) setError(t('computerControlSaveFailed'));
    } finally {
      savingRef.current = false;
      if (active.current && request === revision.current) {
        // Reconcile uncertain writes or deferred changes, without rereading every successful save.
        if (reload || refreshPending.current) {
          refreshPending.current = false;
          await load(false);
        }
        if (active.current) setSaving(false);
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
            {saving ? (
              <span role="status" className="text-primary">
                {t('computerControlSaving')}
              </span>
            ) : (
              t('computerControlEnableDescription')
            )}
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
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ease-out motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${saving ? 'cursor-wait' : 'disabled:cursor-not-allowed disabled:opacity-50'} ${enabled ? 'bg-primary' : 'bg-border'}`}
        >
          <span
            aria-hidden="true"
            className={`absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
          >
            {saving && (
              <span className="h-3 w-3 rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin" />
            )}
          </span>
        </button>
      </div>
      <p className="text-sm leading-6 text-secondary">{t('computerControlModelRequirement')}</p>
      {enabled === true && <ComputerOverlayPreviewSetting />}
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
