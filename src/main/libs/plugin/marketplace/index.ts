import type { OpenClawSkillService } from '../../openclaw/skills/openclawSkillService';
import { OpenClawClawHubProvider } from './openClawClawHubProvider';
import { PluginMarketplaceService } from './pluginMarketplaceService';

export const createPluginMarketplaceService = (
  skillService: OpenClawSkillService,
): PluginMarketplaceService =>
  new PluginMarketplaceService([new OpenClawClawHubProvider(skillService)]);

export { PluginMarketplaceService } from './pluginMarketplaceService';
export type { PluginMarketplaceProvider } from './types';
