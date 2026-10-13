export { createSwarmWorkflowCoordinator } from '../../../../openclaw-extensions/swarm-workflow/host/coordinator';

import type { SwarmWorkflowDependencies as PluginDependencies } from '../../../../openclaw-extensions/swarm-workflow/host/ports';
import type { OpenClawRuntimeAdapter } from '../../engine';

/** Main supplies the original runtime through the plugin's structural live ports. */
export interface SwarmWorkflowDependencies extends PluginDependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
}
