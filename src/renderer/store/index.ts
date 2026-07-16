import { configureStore } from '@reduxjs/toolkit';

import agentReducer from '@/features/agents/agentSlice';
import coworkReducer from '@/features/cowork/coworkSlice';
import modelReducer from '@/features/models/modelSlice';
import mcpReducer from '@/features/plugins/slices/mcpSlice';
import skillReducer from '@/features/plugins/slices/skillSlice';
import scheduledTaskReducer from '@/features/scheduled-tasks/scheduledTaskSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
