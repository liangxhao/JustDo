import { OpenClawProviderId, ProviderRegistry } from '@shared/providers/constants';

import { getCustomProviderDefaultName,getProviderDisplayName, isCustomProvider } from '../config';
import { configService } from '../services/config';
import type { Model } from '../store/slices/modelSlice';

/**
 * Normalize provider name to lowercase for OpenClaw Gateway compatibility.
 * Gateway uses lowercase provider IDs (e.g., "anthropic", "openai", "zai").
 */
function normalizeProviderForGateway(provider: string): string {
  return provider.toLowerCase();
}

export function toOpenClawModelRef(
  model: Pick<Model, 'id' | 'providerKey' | 'provider' | 'isServerModel'>,
): string {
  if (model.isServerModel) {
    // Use JustDo as the provider ID for server models (lowercase)
    return `${OpenClawProviderId.JustDo}/${model.id}`;
  }

  const providerKey = model.providerKey ?? '';

  // For custom providers, use the provider field (displayName) directly if available
  // This avoids calling configService.getConfig() which may not be initialized yet
  if (isCustomProvider(providerKey)) {
    // model.provider is already the displayName (set in App.tsx)
    const displayName = model.provider?.trim() || '';
    if (displayName) {
      return `${normalizeProviderForGateway(displayName)}/${model.id}`;
    }

    // Fallback: get displayName from config (only if model.provider is not set)
    const appConfig = configService.getConfig();
    const providerConfig = appConfig.providers?.[providerKey];
    const configDisplayName = getProviderDisplayName(
      providerKey,
      providerConfig as Record<string, unknown>,
    );
    return `${normalizeProviderForGateway(configDisplayName)}/${model.id}`;
  }

  // Get OpenClaw provider ID and normalize to lowercase
  const openClawProviderId = ProviderRegistry.getOpenClawProviderId(providerKey);
  return `${normalizeProviderForGateway(openClawProviderId)}/${model.id}`;
}

export function matchesOpenClawModelRef(
  modelRef: string,
  model: Pick<Model, 'id' | 'providerKey' | 'provider' | 'isServerModel'>,
): boolean {
  const normalizedRef = modelRef.trim().toLowerCase();
  if (!normalizedRef) return false;

  if (normalizedRef.includes('/')) {
    // Try all possible refs for this model
    const allPossibleRefs = buildAllPossibleModelRefs(model);
    return allPossibleRefs.some(ref => ref.toLowerCase() === normalizedRef);
  }
  return normalizedRef === model.id.toLowerCase();
}

/**
 * Build all possible model refs for a given model to handle different storage formats.
 * This handles the case where agent model was stored with a different displayName
 * (e.g., "Anthropic" -> "anthropic") but the current displayName might be "Custom0".
 */
function buildAllPossibleModelRefs(
  model: Pick<Model, 'id' | 'providerKey' | 'provider' | 'isServerModel'>,
): string[] {
  const refs: string[] = [];

  if (model.isServerModel) {
    refs.push(`${OpenClawProviderId.JustDo}/${model.id}`);
    return refs;
  }

  const providerKey = model.providerKey ?? '';
  const modelId = model.id;
  const providerDisplayName = model.provider?.trim() || '';

  // Always include the current displayName-based ref (from model.provider)
  refs.push(toOpenClawModelRef(model));

  if (isCustomProvider(providerKey)) {
    // For custom providers, try multiple possible displayNames:
    // 1. Current displayName from model.provider (most reliable)
    // 2. Default displayName (e.g., "Custom0")
    // 3. The raw providerKey as provider (e.g., "custom_0")

    if (providerDisplayName) {
      refs.push(`${normalizeProviderForGateway(providerDisplayName)}/${modelId}`);
    }

    // Default displayName (e.g., "Custom0")
    const defaultDisplayName = getCustomProviderDefaultName(providerKey);
    refs.push(`${normalizeProviderForGateway(defaultDisplayName)}/${modelId}`);

    // Raw providerKey (e.g., "custom_0" -> "custom0")
    refs.push(`${normalizeProviderForGateway(providerKey)}/${modelId}`);
  } else {
    // For built-in providers, also try the providerKey directly
    refs.push(`${normalizeProviderForGateway(providerKey)}/${modelId}`);
  }

  // Deduplicate
  return [...new Set(refs)];
}

export function resolveOpenClawModelRef<
  T extends Pick<Model, 'id' | 'providerKey' | 'provider' | 'isServerModel'>,
>(modelRef: string, availableModels: T[]): T | null {
  const normalizedRef = modelRef.trim().toLowerCase();
  if (!normalizedRef) return null;

  if (normalizedRef.includes('/')) {
    // Try to match using all possible refs for each model
    // This handles cases where displayName changed
    for (const model of availableModels) {
      const allPossibleRefs = buildAllPossibleModelRefs(model);
      if (allPossibleRefs.some(ref => ref.toLowerCase() === normalizedRef)) {
        return model;
      }
    }
    return null;
  }

  // For bare model IDs, match against model.id (case-insensitive)
  const matchingModels = availableModels.filter(model => model.id.toLowerCase() === normalizedRef);
  return matchingModels.length === 1 ? matchingModels[0] : null;
}
