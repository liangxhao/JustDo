import { ShareIcon } from '@heroicons/react/24/outline';
import type { SwarmOptions } from '@shared/cowork/swarm';
import { OpenClawExtensionId } from '@shared/openclaw/extensions';

import { i18nService } from '@/services/i18n';

import type { ComposerFeatureRegistration } from './composerFeatures';

/** Swarm-specific defaults and actions stay out of the shared registry and menu. */
export function buildSwarmComposerFeature({
  swarm,
  selectSwarm,
}: {
  swarm?: SwarmOptions;
  selectSwarm: (options: SwarmOptions) => void;
}): ComposerFeatureRegistration {
  return {
    id: OpenClawExtensionId.SWARM_FLOW,
    extensionId: OpenClawExtensionId.SWARM_FLOW,
    label: i18nService.t('swarmTitle'),
    icon: <ShareIcon className="h-4 w-4" />,
    selected: Boolean(swarm),
    onSelect: () => selectSwarm({ mode: 'auto', verify: true }),
  };
}
