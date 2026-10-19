import { mcpToolHasApp } from '@shared/plugins/mcpAppCapabilities';
import type { ReactNode } from 'react';

import type { McpProbeResult } from '@/features/plugins/mcp/mcp';
import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginCard from '@/features/plugins/shared/PluginCard';
import { i18nService } from '@/services/i18n';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

import McpProbeButton from './McpProbeButton';

interface McpServerCardProps {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  stateAction?: ReactNode;
  iconBadge?: ReactNode;
  feedback?: ReactNode;
  visualIndex: number;
  group: 'user' | 'system';
  onOpen?: () => void;
  openLabel: string;
  onProbe: () => void;
  probeDisabled: boolean;
  probing: boolean;
  probeResult?: McpProbeResult;
  supportsApps?: boolean;
}

const McpServerCard = ({
  title,
  description,
  actions,
  stateAction,
  iconBadge,
  feedback,
  visualIndex,
  group,
  onOpen,
  openLabel,
  onProbe,
  probeDisabled,
  probing,
  probeResult,
  supportsApps,
}: McpServerCardProps) => (
  <PluginCard
    compact
    onOpen={onOpen}
    openLabel={openLabel}
    icon={
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${getPluginArtworkTone(`mcp:${group}`, visualIndex)}`}
      >
        <ConnectorIcon className="h-4 w-4" />
      </div>
    }
    iconBadge={iconBadge}
    title={
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 truncate">{title}</div>
        {(probeResult?.available ? probeResult.tools.some(mcpToolHasApp) : supportsApps) && (
          <Tooltip content={i18nService.t('mcpSupportsApps')} position="top" className="shrink-0">
            <span
              tabIndex={0}
              role="note"
              aria-label={i18nService.t('mcpSupportsApps')}
              className="inline-flex shrink-0 whitespace-nowrap rounded-md bg-primary/[0.07] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {i18nService.t('mcpAppBadge')}
            </span>
          </Tooltip>
        )}
      </div>
    }
    actions={
      <>
        {actions}
        <McpProbeButton
          onProbe={onProbe}
          disabled={probeDisabled}
          probing={probing}
          result={probeResult}
        />
        {stateAction}
      </>
    }
    description={description}
    reserveDescriptionSpace={false}
    feedback={feedback}
  />
);

export default McpServerCard;
