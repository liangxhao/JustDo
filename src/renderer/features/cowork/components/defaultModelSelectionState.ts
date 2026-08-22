import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';

import { updateAgent } from '@/features/agents/agentSlice';
import type { Model } from '@/features/models/modelSlice';
import { setSelectedModel } from '@/features/models/modelSlice';
import { toOpenClawModelRef } from '@/features/models/openclawModelRef';

export const syncDefaultModelSelectionState = (
  dispatch: Dispatch<UnknownAction>,
  agentId: string,
  model: Model,
): void => {
  const modelRef = toOpenClawModelRef(model);
  if (modelRef) {
    dispatch(updateAgent({ id: agentId, updates: { model: modelRef } }));
  }
  dispatch(setSelectedModel(model));
};
