import { OpenClawProviderId, ProviderRegistry } from '@shared/providers/constants';
import { isCustomProvider, getProviderDisplayName } from '../config';
import { configService } from '../services/config';

import type { Model } from '../store/slices/modelSlice';

export function toOpenClawModelRef(
  model: Pick<Model, 'id' | 'providerKey' | 'isServerModel'>,
): string {
  if (model.isServerModel) {
    // Use GucciAI as the provider ID for server models
    return `${OpenClawProviderId.GucciAI}/${model.id}`;
  }

  const providerKey = model.providerKey ?? '';

  // For custom providers, use displayName from config instead of custom_*
  if (isCustomProvider(providerKey)) {
    const appConfig = configService.getConfig();
    const providerConfig = appConfig.providers?.[providerKey];
    const displayName = getProviderDisplayName(providerKey, providerConfig as Record<string, unknown>);
    return `${displayName}/${model.id}`;
  }

  return `${ProviderRegistry.getOpenClawProviderId(providerKey)}/${model.id}`;
}

export function matchesOpenClawModelRef(
  modelRef: string,
  model: Pick<Model, 'id' | 'providerKey' | 'isServerModel'>,
): boolean {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return false;
  if (normalizedRef.includes('/')) {
    return normalizedRef === toOpenClawModelRef(model);
  }
  return normalizedRef === model.id;
}

export function resolveOpenClawModelRef<
  T extends Pick<Model, 'id' | 'providerKey' | 'isServerModel'>,
>(modelRef: string, availableModels: T[]): T | null {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return null;

  if (normalizedRef.includes('/')) {
    return availableModels.find(model => toOpenClawModelRef(model) === normalizedRef) ?? null;
  }

  const matchingModels = availableModels.filter(model => model.id === normalizedRef);
  return matchingModels.length === 1 ? matchingModels[0] : null;
}
