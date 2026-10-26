import { toOpenClawModelRef } from '@/features/models/openclawModelRef';
import type { RootState } from '@/store';

import { resolveAgentModelSelection } from './agentModelSelection';

/** Freeze the visible home choice before any asynchronous session preparation. */
export function captureHomeComposerModelRef(state: RootState, agentId: string): string | undefined {
  const contextKey = `__home__\0${agentId}`;
  const model = Object.prototype.hasOwnProperty.call(state.cowork.manualModelSelections, contextKey)
    ? state.cowork.manualModelSelections[contextKey]
    : resolveAgentModelSelection({
        agentId,
        agentModel: state.agent.agents.find(agent => agent.id === agentId)?.model ?? '',
        availableModels: state.model.availableModels,
        fallbackModel: state.model.selectedModel,
      }).selectedModel;
  return model ? toOpenClawModelRef(model) : undefined;
}
