import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, test } from 'vitest';

import agentReducer, { setAgents } from '@/features/agents/agentSlice';
import { syncDefaultModelSelectionState } from '@/features/cowork/components/defaultModelSelectionState';
import modelReducer, { type Model, setAvailableModels } from '@/features/models/modelSlice';

describe('syncDefaultModelSelectionState', () => {
  test('makes an existing-session model change visible to the next new session', () => {
    const previousModel: Model = {
      id: 'gpt-4o',
      name: 'GPT-4o',
      providerKey: 'openai',
    };
    const nextModel: Model = {
      id: 'gpt-5',
      name: 'GPT-5',
      providerKey: 'openai',
    };
    const store = configureStore({
      reducer: {
        agent: agentReducer,
        model: modelReducer,
      },
    });
    store.dispatch(
      setAgents([
        {
          id: 'main',
          name: 'Assistant',
          description: '',
          icon: '',
          model: 'openai/gpt-4o',
          enabled: true,
          isDefault: true,
          skillIds: [],
        },
      ]),
    );
    store.dispatch(setAvailableModels([previousModel, nextModel]));

    syncDefaultModelSelectionState(store.dispatch, 'main', nextModel);

    expect(store.getState().agent.agents[0].model).toBe('openai/gpt-5');
    expect(store.getState().model.selectedModel).toEqual(nextModel);
  });
});
