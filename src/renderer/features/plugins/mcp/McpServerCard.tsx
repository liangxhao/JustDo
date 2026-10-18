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
          <Tooltip content={i18nService.t('mcpSupportsApps')} position="top">
            <span
              tabIndex={0}
              role="img"
              aria-label={i18nService.t('mcpSupportsApps')}
              className="inline-flex shrink-0 rounded text-primary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M3 9h18M8 9v11" />
              </svg>
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
