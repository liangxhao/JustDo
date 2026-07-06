import type { OpenClawRuntimeAdapter } from '../../agentEngine/openclawRuntimeAdapter';
import { OpenClawClawHubProvider } from './openClawClawHubProvider';
import { PluginMarketplaceService } from './pluginMarketplaceService';

export const createPluginMarketplaceService = (
  resolveOpenClawAdapter: () => OpenClawRuntimeAdapter | null,
): PluginMarketplaceService =>
  new PluginMarketplaceService([new OpenClawClawHubProvider(resolveOpenClawAdapter)]);

export { PluginMarketplaceService } from './pluginMarketplaceService';
export type { PluginMarketplaceProvider } from './types';
