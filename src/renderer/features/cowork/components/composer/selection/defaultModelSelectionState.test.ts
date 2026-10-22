import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, test } from 'vitest';

import agentReducer, { setAgents } from '@/features/agents/agentSlice';
import { syncDefaultModelSelectionState } from '@/features/cowork/components/composer/selection/defaultModelSelectionState';
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

    expect(store.getState().agent.agents[0].model).toBe('');
    expect(store.getState().model.selectedModel).toEqual(nextModel);
  });
});

test('a specialist selection leaves the inherited application model unchanged', () => {
  const dispatch = <T>(action: T): T => {
    actions.push(action);
    return action;
  };
  const actions: unknown[] = [];
  syncDefaultModelSelectionState(dispatch, 'review', {
    id: 'review-model',
    name: 'Review',
    providerKey: 'openai',
  });
  expect(actions).toEqual([
    expect.objectContaining({
      type: 'agent/updateAgent',
      payload: { id: 'review', updates: { model: 'openai/review-model' } },
    }),
  ]);
});
