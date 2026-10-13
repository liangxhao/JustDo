import { ShareIcon } from '@heroicons/react/24/outline';
import type { SwarmWorkflowOptions } from '@shared/cowork/swarm-workflow';

import { i18nService } from '@/services/i18n';

import { buildWorkflowComposerFeature } from '../../../../../../openclaw-extensions/swarm-workflow/browser/composer';
import type { ComposerFeatureRegistration } from './composerFeatures';

/** Swarm Workflow defaults and actions stay out of the shared registry and menu. */
export function buildSwarmWorkflowComposerFeature({
  swarmWorkflow,
  selectSwarmWorkflow,
}: {
  swarmWorkflow?: SwarmWorkflowOptions;
  selectSwarmWorkflow: (options: SwarmWorkflowOptions) => void;
}): ComposerFeatureRegistration {
  const { labelKey, ...feature } = buildWorkflowComposerFeature({
    swarmWorkflow,
    selectSwarmWorkflow,
  });
  return { ...feature, label: i18nService.t(labelKey), icon: <ShareIcon className="h-4 w-4" /> };
}
