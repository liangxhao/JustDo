import { buildProviderSelection } from '../../openclaw/config/openclawConfigBuilders';
import {
  type ProviderRawConfig,
  resolveAllEnabledProviderConfigs,
  validateConfiguredOpenClawProviderNames,
} from '../../providers/providerApiConfig';
import type { ExternalAgentModel } from './externalAgentTypes';

export function buildExternalAgentModelCatalog(
  providers: ProviderRawConfig[],
  defaultModelRef: string,
): ExternalAgentModel[] {
  const models = new Map<string, ExternalAgentModel>();
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.enabled === false || !model.id.trim()) continue;
      const selection = buildProviderSelection({
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        modelId: model.id.trim(),
        apiType: provider.apiType,
        providerName: provider.providerName,
        supportsImage: model.supportsImage,
        modelName: model.name,
        displayName: provider.displayName,
      });
      const id = selection.primaryModel;
      if (!models.has(id))
        models.set(id, {
          id,
          name: `${model.name?.trim() || model.id} (${provider.displayName || selection.providerId})`,
          isDefault: id === defaultModelRef,
        });
    }
  }
  return [...models.values()];
}

export function getExternalAgentModelCatalog(defaultModelRef: string): ExternalAgentModel[] {
  if (!validateConfiguredOpenClawProviderNames().ok) return [];
  return buildExternalAgentModelCatalog(resolveAllEnabledProviderConfigs(), defaultModelRef);
}
