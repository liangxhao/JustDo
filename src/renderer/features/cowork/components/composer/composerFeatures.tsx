import { ShareIcon } from '@heroicons/react/24/outline';
import type { SwarmOptions } from '@shared/cowork/swarm';

import { i18nService } from '@/services/i18n';

import type { ComposerFeatureItem } from './ComposerFeatureMenu';

/** Add composer capabilities here; the menu does not know their state or submit semantics. */
export function buildComposerFeatures({
  swarm,
  selectSwarm,
}: {
  swarm?: SwarmOptions;
  selectSwarm: (options: SwarmOptions) => void;
}): ComposerFeatureItem[] {
  return [
    {
      id: 'swarm',
      label: i18nService.t('swarmTitle'),
      icon: <ShareIcon className="h-4 w-4" />,
      selected: Boolean(swarm),
      onSelect: () => selectSwarm({ mode: 'auto', verify: true }),
    },
  ];
}
