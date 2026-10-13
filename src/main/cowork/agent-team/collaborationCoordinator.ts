export * from '../../../../openclaw-extensions/agent-team/host/collaboration/collaborationCoordinator';

import type { CollaborationDependencies as PluginDependencies } from '../../../../openclaw-extensions/agent-team/host/collaboration/collaborationCoordinator';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../engine';

/** Main's event wiring uses concrete resources; plugin coordination sees only typed ports. */
export interface CollaborationDependencies extends PluginDependencies {
  getStore: () => CoworkStore;
  getRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
}
