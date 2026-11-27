import { i18nService } from '@/services/i18n';

export function McpAppLoadingStatus() {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-secondary">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-spin"
      />
      {i18nService.t('mcpAppsLoading')}
    </span>
  );
}
