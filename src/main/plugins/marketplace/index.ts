import type { PluginInstallationService } from '../installation';
import { PluginMarketplaceService } from './pluginMarketplaceService';

// Product builds register the configured enterprise provider here. Keeping the
// default empty avoids coupling the application boundary to a public market.
export const createPluginMarketplaceService = (
  installationService: PluginInstallationService,
): PluginMarketplaceService => new PluginMarketplaceService([], installationService);

export { PluginMarketplaceService } from './pluginMarketplaceService';
export type { PluginMarketplaceProvider } from './types';
