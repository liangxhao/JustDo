import { type CustomProxyConfig, ProxyMode } from '@shared/network/proxy';

import { i18nService } from '@/services/i18n';

import { CustomProxyFields } from './CustomProxyFields';

interface ProxySettingsSectionProps {
  id: string;
  titleKey: string;
  descriptionKey: string;
  proxyMode: ProxyMode;
  handleProxyModeChange: (mode: ProxyMode) => void;
  customProxy: CustomProxyConfig;
  handleCustomProxyChange: (key: keyof CustomProxyConfig, value: string) => void;
  isSaving: boolean;
}

export function ProxySettingsSection({
  id,
  titleKey,
  descriptionKey,
  proxyMode,
  handleProxyModeChange,
  customProxy,
  handleCustomProxyChange,
  isSaving,
}: ProxySettingsSectionProps) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-xl border px-4 py-4 border-border"
    >
      <h4 id={`${id}-title`} className="text-sm font-medium text-foreground mb-3">
        {i18nService.t(titleKey)}
      </h4>
      <p className="text-xs text-secondary">{i18nService.t(descriptionKey)}</p>
      <div className="space-y-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name={id}
            disabled={isSaving}
            value={ProxyMode.DIRECT}
            checked={proxyMode === ProxyMode.DIRECT}
            onChange={() => handleProxyModeChange(ProxyMode.DIRECT)}
            className="mt-0.5 h-4 w-4 text-primary focus:ring-primary bg-surface border-border"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">
              {i18nService.t('noProxy')}
            </span>
            <span className="block text-xs text-secondary mt-1">
              {i18nService.t('noProxyDescription')}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name={id}
            disabled={isSaving}
            value={ProxyMode.SYSTEM}
            checked={proxyMode === ProxyMode.SYSTEM}
            onChange={() => handleProxyModeChange(ProxyMode.SYSTEM)}
            className="mt-0.5 h-4 w-4 text-primary focus:ring-primary bg-surface border-border"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">
              {i18nService.t('useSystemProxy')}
            </span>
            <span className="block text-xs text-secondary mt-1">
              {i18nService.t('useSystemProxyDescription')}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name={id}
            disabled={isSaving}
            value={ProxyMode.CUSTOM}
            checked={proxyMode === ProxyMode.CUSTOM}
            onChange={() => handleProxyModeChange(ProxyMode.CUSTOM)}
            className="mt-0.5 h-4 w-4 text-primary focus:ring-primary bg-surface border-border"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">
              {i18nService.t('customProxy')}
            </span>
            <span className="block text-xs text-secondary mt-1">
              {i18nService.t('customProxyDescription')}
            </span>
          </span>
        </label>
      </div>

      {proxyMode === ProxyMode.CUSTOM && (
        <div className="pl-7 max-w-[640px]">
          <CustomProxyFields
            id={id}
            customProxy={customProxy}
            handleCustomProxyChange={handleCustomProxyChange}
            isSaving={isSaving}
          />
        </div>
      )}

      <div className="flex justify-end pl-7 max-w-[640px]">
        <button
          type="submit"
          disabled={isSaving}
          className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          {isSaving ? i18nService.t('saving') : i18nService.t('save')}
        </button>
      </div>
    </section>
  );
}
