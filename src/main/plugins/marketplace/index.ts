import { PluginMarketplaceService } from './pluginMarketplaceService';

// Product builds register the configured enterprise provider here. Keeping the
// default empty avoids coupling the application boundary to a public market.
export const createPluginMarketplaceService = (): PluginMarketplaceService =>
  new PluginMarketplaceService([]);

export { PluginMarketplaceService } from './pluginMarketplaceService';
export type { PluginMarketplaceProvider } from './types';
