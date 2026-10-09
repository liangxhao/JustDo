import { ShareIcon } from '@heroicons/react/24/outline';
import type { SwarmWorkflowOptions } from '@shared/cowork/swarmWorkflow';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';

import { i18nService } from '@/services/i18n';

import type { ComposerFeatureRegistration } from './composerFeatures';

/** Swarm Workflow defaults and actions stay out of the shared registry and menu. */
export function buildSwarmWorkflowComposerFeature({
  swarmWorkflow,
  selectSwarmWorkflow,
}: {
  swarmWorkflow?: SwarmWorkflowOptions;
  selectSwarmWorkflow: (options: SwarmWorkflowOptions) => void;
}): ComposerFeatureRegistration {
  return {
    id: OpenClawExtensionId.SWARM_WORKFLOW,
    extensionId: OpenClawExtensionId.SWARM_WORKFLOW,
    label: i18nService.t('swarmWorkflowTitle'),
    icon: <ShareIcon className="h-4 w-4" />,
    selected: Boolean(swarmWorkflow),
    onSelect: () => selectSwarmWorkflow({ mode: 'auto', verify: true }),
  };
}
