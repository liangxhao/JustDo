import {
  DEFAULT_MODEL_CONTEXT_LENGTH,
  DEFAULT_MODEL_MAX_TOKENS,
} from '@shared/providers/modelDiscovery';

type ModelCapabilityState = {
  capabilitiesConfirmed?: boolean;
  supportsImage?: boolean;
  contextLength?: number;
  maxTokens?: number;
};

export const hasConfirmedModelCapabilities = (model: ModelCapabilityState): boolean => {
  if (model.capabilitiesConfirmed !== undefined) {
    return model.capabilitiesConfirmed;
  }

  // Legacy configs did not store a confirmation marker. Preserve clearly customized
  // values, while treating the old generated default tuple as unconfirmed.
  return (
    model.supportsImage === true ||
    (model.contextLength !== undefined && model.contextLength !== DEFAULT_MODEL_CONTEXT_LENGTH) ||
    (model.maxTokens !== undefined && model.maxTokens !== DEFAULT_MODEL_MAX_TOKENS)
  );
};
