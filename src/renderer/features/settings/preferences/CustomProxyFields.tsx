import { type CustomProxyConfig, ProxyProtocol } from '@shared/network/proxy';

import { i18nService } from '@/services/i18n';

interface CustomProxyFieldsProps {
  id: string;
  customProxy: CustomProxyConfig;
  handleCustomProxyChange: (key: keyof CustomProxyConfig, value: string) => void;
  isSaving: boolean;
}

export function CustomProxyFields({
  id,
  customProxy,
  handleCustomProxyChange,
  isSaving,
}: CustomProxyFieldsProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_8rem]">
        <div>
          <label htmlFor={`${id}-host`} className="block text-xs font-medium text-secondary mb-1">
            {i18nService.t('proxyHost')}
          </label>
          <div className="flex w-full overflow-hidden rounded-lg border border-border bg-surface-inset focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30">
            <select
              id={`${id}-protocol`}
              disabled={isSaving}
              value={customProxy.protocol}
              onChange={e =>
                handleCustomProxyChange('protocol', e.target.value as CustomProxyConfig['protocol'])
              }
              aria-label={i18nService.t('proxyProtocol')}
              className="w-28 shrink-0 border-0 border-r border-border bg-surface px-3 py-2 text-sm font-medium text-foreground focus:outline-none"
            >
              <option value={ProxyProtocol.HTTP}>HTTP</option>
              <option value={ProxyProtocol.HTTPS}>HTTPS</option>
            </select>
            <input
              disabled={isSaving}
              id={`${id}-host`}
              type="text"
              value={customProxy.host}
              onChange={e => handleCustomProxyChange('host', e.target.value)}
              className="block min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-sm text-foreground focus:outline-none"
              placeholder="127.0.0.1"
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-port`} className="block text-xs font-medium text-secondary mb-1">
            {i18nService.t('proxyPort')}
          </label>
          <input
            disabled={isSaving}
            id={`${id}-port`}
            type="number"
            min={1}
            max={65535}
            value={customProxy.port}
            onChange={e => handleCustomProxyChange('port', e.target.value)}
            className="block w-full rounded-lg bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm"
            placeholder="7890"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label
            htmlFor={`${id}-username`}
            className="block text-xs font-medium text-secondary mb-1"
          >
            {i18nService.t('proxyUsername')}
          </label>
          <input
            disabled={isSaving}
            id={`${id}-username`}
            type="text"
            value={customProxy.username ?? ''}
            onChange={e => handleCustomProxyChange('username', e.target.value)}
            className="block w-full rounded-lg bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm"
            placeholder={i18nService.t('optional')}
          />
        </div>
        <div>
          <label
            htmlFor={`${id}-password`}
            className="block text-xs font-medium text-secondary mb-1"
          >
            {i18nService.t('proxyPassword')}
          </label>
          <input
            disabled={isSaving}
            id={`${id}-password`}
            type="password"
            value={customProxy.password ?? ''}
            onChange={e => handleCustomProxyChange('password', e.target.value)}
            className="block w-full rounded-lg bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm"
            placeholder={i18nService.t('optional')}
          />
        </div>
      </div>
    </div>
  );
}
