import { useState } from 'react';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

export function ComputerOverlayPreviewSetting() {
  const [enabled, setEnabled] = useState(
    configService.getConfig().computerOverlayRemotePreview === true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="flex items-center justify-between gap-6 rounded-2xl border border-border bg-surface-raised/50 p-5">
      <div className="min-w-0">
        <h4 className="text-sm font-medium text-foreground">
          {i18nService.t('computerOverlayRemotePreview')}
        </h4>
        <p className="mt-1 text-xs leading-5 text-secondary">
          {i18nService.t('computerOverlayRemotePreviewDescription')}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {i18nService.t('computerOverlayRemotePreviewError')}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={i18nService.t('computerOverlayRemotePreview')}
        aria-checked={enabled}
        disabled={saving}
        onClick={async () => {
          if (saving) return;
          setSaving(true);
          setError(false);
          try {
            await configService.updateConfig({ computerOverlayRemotePreview: !enabled });
            setEnabled(!enabled);
          } catch {
            setError(true);
          } finally {
            setSaving(false);
          }
        }}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
        />
      </button>
    </div>
  );
}
