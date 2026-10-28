import { OpenClawProviderId, ProviderRegistry } from '@shared/providers/constants';

import { getCustomProviderDefaultName, isCustomProvider } from '@/app/config';
import type { Model } from '@/features/models/modelSlice';

/**
 * Normalize provider name to lowercase for OpenClaw Gateway compatibility.
 * Gateway uses lowercase provider IDs.
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

  // Custom display names are validated against OpenClaw's reserved provider
  // inventory before saving, so the user-visible identity can also be the
  // wire-level provider ID shown to the model.
  if (isCustomProvider(providerKey)) {
    const displayName = model.provider?.trim() || getCustomProviderDefaultName(providerKey);
    return `${normalizeProviderForGateway(displayName)}/${model.id}`;
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

/** Resolve current application and native discovery model references. */
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
  refs.push(toOpenClawModelRef(model));
  // Built-in discovery ids can themselves contain a Gateway provider prefix
  // (for example `hdp/Glm-5.1`). Keep the raw id as a compatibility alias for
  // sessions.describe responses that omit the local `builtin_models` prefix.
  if (providerKey === 'builtin_models' && modelId.includes('/')) {
    refs.push(modelId);
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
