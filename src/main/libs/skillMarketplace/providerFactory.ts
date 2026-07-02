import type { OpenClawRuntimeAdapter } from '../agentEngine/openclawRuntimeAdapter';
import { OpenClawGatewayMarketplaceProvider } from './openClawGatewayProvider';
import { SkillMarketplaceService } from './skillMarketplaceService';

/**
 * Composition root for marketplace integrations.
 *
 * To switch to a private marketplace, instantiate its provider here. The rest of
 * the application depends only on SkillMarketplaceProvider and needs no changes.
 */
export const createSkillMarketplaceService = (
  resolveOpenClawAdapter: () => OpenClawRuntimeAdapter | null,
): SkillMarketplaceService =>
  new SkillMarketplaceService(new OpenClawGatewayMarketplaceProvider(resolveOpenClawAdapter));
