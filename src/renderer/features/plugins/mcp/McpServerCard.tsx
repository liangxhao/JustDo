import type { ReactNode } from 'react';

import type { McpProbeResult } from '@/features/plugins/mcp/mcp';
import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginCard from '@/features/plugins/shared/PluginCard';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';

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
    title={title}
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
