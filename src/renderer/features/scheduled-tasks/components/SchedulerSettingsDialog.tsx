import { XMarkIcon } from '@heroicons/react/24/outline';
import { parseSessionRetentionMs } from '@shared/scheduledTask/retention';
import type { SchedulerSettings, SchedulerSettingsSnapshot } from '@shared/scheduledTask/types';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

const PRESETS = ['24h', '7d', '30d', '90d'] as const;

export default function SchedulerSettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (settings: SchedulerSettings) => void;
}) {
  const t = i18nService.t.bind(i18nService);
  const [snapshot, setSnapshot] = useState<SchedulerSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<SchedulerSettings | null>(null);
  const [retentionChoice, setRetentionChoice] = useState('7d');
  const [customRetention, setCustomRetention] = useState('7d');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!pendingRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter(item => !item.closest('fieldset:disabled'));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.resolve()
      .then(() => window.electron.scheduledTasks.getSchedulerSettings())
      .then(result => {
        if (!active) return;
        if (!result.success || !result.snapshot) throw new Error('Unavailable');
        const next = result.snapshot;
        setSnapshot(next);
        setDraft(next.settings);
        const retention = next.settings.sessionRetention;
        setRetentionChoice(
          retention === false || parseSessionRetentionMs(retention) === 0
            ? 'forever'
            : PRESETS.some(preset => preset === retention)
              ? retention
              : 'custom',
        );
        setCustomRetention(retention === false ? '7d' : retention);
      })
      .catch(() => {
        if (active) setError('schedulerSettingsLoadFailed');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [readRevision]);

  const retention =
    retentionChoice === 'forever'
      ? false
      : retentionChoice === 'custom'
        ? customRetention.trim()
        : retentionChoice;
  const invalidRetention =
    retention !== false &&
    (retention.length > 128 ||
      parseSessionRetentionMs(retention) === null ||
      parseSessionRetentionMs(retention) === 0);
  const effective: SchedulerSettings | null = draft
    ? { ...draft, sessionRetention: retention }
    : null;
  const patch: Partial<SchedulerSettings> = {};
  if (effective && snapshot) {
    if (effective.enabled !== snapshot.settings.enabled) patch.enabled = effective.enabled;
    if (effective.skipMissedJobs !== snapshot.settings.skipMissedJobs)
      patch.skipMissedJobs = effective.skipMissedJobs;
    if (effective.sessionRetention !== snapshot.settings.sessionRetention)
      patch.sessionRetention = effective.sessionRetention;
  }
  const save = async () => {
    if (
      pendingRef.current ||
      !snapshot ||
      !effective ||
      invalidRetention ||
      !Object.keys(patch).length
    )
      return;
    pendingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await window.electron.scheduledTasks.updateSchedulerSettings({
        patch,
        revision: snapshot.revision,
      });
      if (!result.success) throw new Error('Save failed');
      onSaved(effective);
      onClose();
    } catch {
      setError('schedulerSettingsSaveFailed');
    } finally {
      pendingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={() => {
        if (!pendingRef.current) onClose();
      }}
      className="mx-4 w-full max-w-lg rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduler-settings-title"
        className="flex max-h-[85vh] flex-col outline-none"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 id="scheduler-settings-title" className="text-base font-semibold text-foreground">
            {t('schedulerSettingsTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={t('close')}
            className="rounded-lg p-1 text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {loading ? (
            <p role="status" className="text-sm text-secondary">
              {t('loading')}
            </p>
          ) : (
            draft && (
              <fieldset disabled={saving} className="space-y-5 disabled:opacity-60">
                <label className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {t('schedulerSettingsEnabled')}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-secondary">
                      {t('schedulerSettingsEnabledHint')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t('schedulerSettingsEnabled')}
                    checked={draft.enabled}
                    onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  />
                </label>
                <label className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {t('schedulerSettingsCatchUp')}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-secondary">
                      {t('schedulerSettingsCatchUpHint')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t('schedulerSettingsCatchUp')}
                    checked={!draft.skipMissedJobs}
                    onChange={event =>
                      setDraft({ ...draft, skipMissedJobs: !event.target.checked })
                    }
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  />
                </label>
                <div className="border-t border-border-subtle pt-4">
                  <label
                    htmlFor="scheduler-retention"
                    className="text-sm font-medium text-foreground"
                  >
                    {t('schedulerSettingsRetention')}
                  </label>
                  <select
                    id="scheduler-retention"
                    value={retentionChoice}
                    onChange={event => setRetentionChoice(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground"
                  >
                    {PRESETS.map(preset => (
                      <option key={preset} value={preset}>
                        {t(`schedulerSettingsRetention${preset}`)}
                      </option>
                    ))}
                    <option value="forever">{t('schedulerSettingsRetentionForever')}</option>
                    <option value="custom">{t('schedulerSettingsRetentionCustom')}</option>
                  </select>
                  {retentionChoice === 'custom' && (
                    <input
                      aria-label={t('schedulerSettingsRetentionCustom')}
                      aria-invalid={invalidRetention}
                      value={customRetention}
                      onChange={event => setCustomRetention(event.target.value)}
                      maxLength={128}
                      placeholder={t('schedulerSettingsRetentionExample')}
                      className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground"
                    />
                  )}
                  {invalidRetention && (
                    <p role="alert" className="mt-2 text-xs text-red-500">
                      {t('schedulerSettingsRetentionInvalid')}
                    </p>
                  )}
                </div>
              </fieldset>
            )
          )}
          {error && (
            <div role="alert" className="mt-3 text-sm text-red-500">
              <p>{t(error)}</p>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setSnapshot(null);
                  setReadRevision(value => value + 1);
                }}
                className="mt-2 underline"
              >
                {t('schedulerSettingsReload')}
              </button>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl px-4 py-2 text-sm text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving || !draft || invalidRetention || !Object.keys(patch).length}
            className="rounded-xl bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {t(saving ? 'schedulerSettingsSaving' : 'save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
