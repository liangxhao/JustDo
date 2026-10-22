import { isSameModelIdentity, type Model } from '@/features/models/modelSlice';
import { resolveOpenClawModelRef } from '@/features/models/openclawModelRef';

type ResolveAgentModelSelectionInput = {
  agentModel: string;
  agentId?: string;
  sessionModel?: string;
  availableModels: Model[];
  fallbackModel: Model | null;
};

type ResolveAgentModelSelectionResult = {
  selectedModel: Model | null;
  usesFallback: boolean;
  hasInvalidExplicitModel: boolean;
};

export function resolveAgentModelSelection({
  agentModel,
  agentId,
  sessionModel,
  availableModels,
  fallbackModel,
}: ResolveAgentModelSelectionInput): ResolveAgentModelSelectionResult {
  const resolvedFallback =
    availableModels.find(model => isSameModelIdentity(model, fallbackModel ?? undefined)) ??
    availableModels[0] ??
    null;
  const normalizedAgentModel =
    sessionModel?.trim() || (agentId === 'main' ? '' : agentModel.trim());
  if (normalizedAgentModel) {
    const explicitModel = resolveOpenClawModelRef(normalizedAgentModel, availableModels) ?? null;
    if (explicitModel) {
      return { selectedModel: explicitModel, usesFallback: false, hasInvalidExplicitModel: false };
    }

    // Managed agent config constrains a removed profile model to the application
    // default. Keep that effective selection visible while the saved profile
    // still references the retired model.
    return { selectedModel: resolvedFallback, usesFallback: true, hasInvalidExplicitModel: true };
  }

  return { selectedModel: resolvedFallback, usesFallback: true, hasInvalidExplicitModel: false };
}
