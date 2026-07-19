import { SparklesIcon } from '@heroicons/react/24/outline';
import { PluginKind } from '@shared/plugins/marketplace';
import React from 'react';

import MarketplaceView, {
  type InstalledMarketplacePlugin,
} from '@/features/plugins/components/marketplace/MarketplaceView';

interface SkillMarketplaceProps {
  installed: InstalledMarketplacePlugin[];
  readOnly?: boolean;
  onInstalled?: () => void | Promise<void>;
}

const SkillMarketplace: React.FC<SkillMarketplaceProps> = props => (
  <MarketplaceView kind={PluginKind.SKILL} icon={<SparklesIcon className="h-4 w-4" />} {...props} />
);

export default SkillMarketplace;
