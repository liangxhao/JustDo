import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import { i18nService } from '@/services/i18n';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';

import type { ExtensionProvidedMcpServer } from './mcp';

interface ExtensionMcpCardProps {
  server: ExtensionProvidedMcpServer;
  visualIndex: number;
  group: 'user' | 'system';
  onOpenExtension?: (extensionId: string) => void;
}

const ExtensionMcpCard = ({
  server,
  visualIndex,
  group,
  onOpenExtension,
}: ExtensionMcpCardProps) => (
  <div className="group min-h-16 min-w-0 rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-border/70 hover:bg-surface-raised/70">
    <div className="flex items-start gap-2">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${getPluginArtworkTone(`mcp:${group}`, visualIndex)}`}
      >
        <ConnectorIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{server.name}</div>
        <button
          type="button"
          onClick={() => onOpenExtension?.(server.providerId)}
          disabled={!onOpenExtension}
          aria-label={i18nService.t('openExtensionDetails').replace('{name}', server.providerName)}
          className="mt-1 block max-w-full truncate text-left text-xs text-secondary transition-colors enabled:hover:text-primary disabled:cursor-default"
        >
          {i18nService.t('mcpProvidedByExtension').replace('{name}', server.providerName)}
        </button>
      </div>
    </div>
    <div className="mt-3 flex items-center gap-1.5 text-[10px]">
      <span className="rounded bg-purple-500/10 px-1.5 py-0.5 font-medium text-purple-600 dark:text-purple-400">
        {i18nService.t('mcpExtensionBadge')}
      </span>
      {!server.enabled && (
        <span className="rounded bg-surface-raised px-1.5 py-0.5 font-medium text-secondary">
          {i18nService.t('mcpExtensionDisabled')}
        </span>
      )}
      {!server.supported && (
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
          {i18nService.t('mcpExtensionUnsupported')}
        </span>
      )}
    </div>
  </div>
);

export default ExtensionMcpCard;
