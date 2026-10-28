type ModelCapabilityState = {
  capabilitiesConfirmed?: boolean;
  supportsImage?: boolean;
  contextLength?: number;
  maxTokens?: number;
};

export const hasConfirmedModelCapabilities = (model: ModelCapabilityState): boolean =>
  model.capabilitiesConfirmed === true;
