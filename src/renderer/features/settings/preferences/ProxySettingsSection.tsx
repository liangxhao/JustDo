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
  embedded?: boolean;
}

const PROXY_OPTIONS = [
  { value: ProxyMode.DIRECT, titleKey: 'noProxy', descriptionKey: 'noProxyDescription' },
  {
    value: ProxyMode.SYSTEM,
    titleKey: 'useSystemProxy',
    descriptionKey: 'useSystemProxyDescription',
  },
  { value: ProxyMode.CUSTOM, titleKey: 'customProxy', descriptionKey: 'customProxyDescription' },
] as const;

export function ProxySettingsSection({
  id,
  titleKey,
  descriptionKey,
  proxyMode,
  handleProxyModeChange,
  customProxy,
  handleCustomProxyChange,
  isSaving,
  embedded = false,
}: ProxySettingsSectionProps) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={
        embedded ? 'space-y-4 py-5' : 'space-y-4 rounded-xl border border-border px-4 py-4'
      }
    >
      <div>
        <h4 id={`${id}-title`} className="text-sm font-medium text-foreground">
          {i18nService.t(titleKey)}
        </h4>
        <p className="mt-1 text-xs leading-5 text-secondary">{i18nService.t(descriptionKey)}</p>
      </div>
      <div className={embedded ? 'grid gap-3 md:grid-cols-3' : 'space-y-3'}>
        {PROXY_OPTIONS.map(option => (
          <label
            key={option.value}
            className={`flex items-start gap-3 ${isSaving ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${
              embedded
                ? `rounded-xl border p-3.5 transition-colors focus-within:ring-2 focus-within:ring-primary ${
                    proxyMode === option.value
                      ? 'border-primary bg-primary-muted'
                      : 'border-border-subtle bg-surface hover:border-border hover:bg-surface-raised'
                  }`
                : ''
            }`}
          >
            <input
              type="radio"
              name={id}
              disabled={isSaving}
              value={option.value}
              checked={proxyMode === option.value}
              onChange={() => handleProxyModeChange(option.value)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary text-primary focus:ring-primary bg-surface border-border"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {i18nService.t(option.titleKey)}
              </span>
              <span className="mt-1 block text-xs leading-5 text-secondary">
                {i18nService.t(option.descriptionKey)}
              </span>
            </span>
          </label>
        ))}
      </div>

      {proxyMode === ProxyMode.CUSTOM && (
        <div
          className={
            embedded
              ? 'rounded-xl bg-surface-raised p-4 [&_input]:bg-surface [&_select]:bg-surface'
              : 'pl-7 max-w-[640px]'
          }
        >
          <CustomProxyFields
            id={id}
            customProxy={customProxy}
            handleCustomProxyChange={handleCustomProxyChange}
            isSaving={isSaving}
          />
        </div>
      )}

      <div className={embedded ? 'flex justify-end' : 'flex justify-end pl-7 max-w-[640px]'}>
        <button
          type="submit"
          disabled={isSaving}
          className={
            embedded
              ? 'inline-flex h-9 items-center rounded-lg border border-border bg-surface px-4 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50'
              : 'px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]'
          }
        >
          {isSaving ? i18nService.t('saving') : i18nService.t('save')}
        </button>
      </div>
    </section>
  );
}
