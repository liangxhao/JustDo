import type { OpenClawModelChoice } from '@shared/openclaw/models';

import type { Model } from '@/features/models/modelSlice';
import { toOpenClawModelRef } from '@/features/models/openclawModelRef';

export const enrichModelsFromOpenClawCatalog = (
  models: Model[],
  catalog: OpenClawModelChoice[],
): Model[] => {
  if (catalog.length === 0) return models;

  const catalogByRef = new Map(
    catalog.map(choice => [`${choice.provider}/${choice.id}`.toLowerCase(), choice]),
  );

  return models.map(model => {
    const choice = catalogByRef.get(toOpenClawModelRef(model).toLowerCase());
    if (!choice) return model;

    return {
      ...model,
      available: choice.available,
      unavailableReason: choice.unavailableReason,
      unavailableUntil: choice.unavailableUntil,
      supportsImage: choice.input ? choice.input.includes('image') : model.supportsImage,
      contextLength: choice.contextWindow ?? model.contextLength,
      reasoning: choice.reasoning,
      supportsTools: choice.supportsTools,
    };
  });
};
