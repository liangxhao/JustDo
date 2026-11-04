import type { ExtensionDataInfoResult } from '@shared/plugins/extensions';
import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

const formatDataSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`;
};

/** A late estimate never changes the selection of a newer uninstall dialog. */
const ExtensionDataCleanup: React.FC<{
  extensionId: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}> = ({ extensionId, checked, disabled, onChange }) => {
  const [info, setInfo] = useState<ExtensionDataInfoResult | null>(null);
  useEffect(() => {
    let current = true;
    setInfo(null);
    onChange(false);
    void (async () => {
      try {
        const result = await window.electron.extensions.dataInfo({ extensionId });
        if (current) setInfo(result);
      } catch {
        if (current) setInfo({ success: false });
      }
    })();
    return () => { current = false; };
  }, [extensionId, onChange]);

  const available = info?.success === true && info.canDelete === true && info.exists === true &&
    typeof info.bytes === 'number' && Number.isSafeInteger(info.bytes) && info.bytes >= 0;
  const status = !info
    ? i18nService.t('extensionDataSizeLoading')
    : info.success && info.retained
      ? i18nService.t('extensionDataRetained')
      : !info.success || !info.canDelete
      ? i18nService.t('extensionDataCleanupUnavailable')
      : !info.exists
        ? i18nService.t('extensionDataNone')
        : i18nService.t('extensionDataSize').replace('{size}', formatDataSize(info.bytes ?? 0));

  return (
    <div className="mt-4 rounded-lg border border-border p-3">
      <label className="flex items-start gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={checked && available}
          disabled={disabled || !available}
          onChange={event => onChange(event.target.checked && available)}
          className="mt-0.5 accent-primary"
        />
        <span>{i18nService.t('extensionDeleteData')}</span>
      </label>
      <p className="mt-2 text-xs text-secondary" aria-live="polite">{status}</p>
      <p className="mt-1 text-xs text-secondary">{i18nService.t('extensionDataPreserved')}</p>
    </div>
  );
};

export default ExtensionDataCleanup;
