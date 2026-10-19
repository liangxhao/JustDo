import ExtensionBadge from '@/features/plugins/shared/ExtensionBadge';
import PluginStateButton, {
  PluginLockedIndicator,
} from '@/features/plugins/shared/PluginStateButton';
import { i18nService } from '@/services/i18n';

import type { ExtensionProvidedMcpServer, McpProbeResult } from './mcp';
import McpServerCard from './McpServerCard';

interface ExtensionMcpCardProps {
  server: ExtensionProvidedMcpServer;
  visualIndex: number;
  group: 'user' | 'system';
  onOpenExtension?: (extensionId: string) => void;
  onOpenDetail: () => void;
  onOpenParameters: () => void;
  onToggle: () => void;
  updating: boolean;
  probing: boolean;
  probeResult?: McpProbeResult;
  supportsApps?: boolean;
}

const ExtensionMcpCard = ({
  server,
  visualIndex,
  group,
  onOpenExtension,
  onOpenDetail,
  onOpenParameters,
  onToggle,
  updating,
  probing,
  probeResult,
  supportsApps,
}: ExtensionMcpCardProps) => (
  <McpServerCard
    visualIndex={visualIndex}
    group={group}
    iconBadge={
      <ExtensionBadge
        label={i18nService.t('openExtensionDetails').replace('{name}', server.providerName)}
        onOpen={onOpenExtension ? () => onOpenExtension(server.providerId) : undefined}
      />
    }
    onOpen={updating || probing ? undefined : onOpenParameters}
    openLabel={`${i18nService.t('mcpViewParameters')}: ${server.name}`}
    onProbe={onOpenDetail}
    probeDisabled={probing || updating || !server.supported}
    probing={probing}
    probeResult={probeResult}
    supportsApps={supportsApps ?? server.supportsApps}
    title={
      <span className="block max-w-full truncate text-sm font-medium text-foreground">
        {server.name}
      </span>
    }
    stateAction={
      (server.enabled ? server.management?.disable.allowed : server.management?.enable.allowed) ? (
        <PluginStateButton
          checked={server.enabled}
          label={i18nService.t(server.enabled ? 'disableMcpServer' : 'enableMcpServer')}
          busy={updating}
          disabled={updating || probing}
          onToggle={onToggle}
        />
      ) : (
        <PluginLockedIndicator
          checked={server.enabled}
          label={i18nService
            .t('mcpExtensionToggleUnavailable')
            .replace('{name}', server.providerName)}
        />
      )
    }
    description={
      <p className="line-clamp-2 max-w-full break-words">
        {i18nService.t('mcpProvidedByExtension').replace('{name}', server.providerName)}
      </p>
    }
  />
);

export default ExtensionMcpCard;
