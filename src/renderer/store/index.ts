import { configureStore } from '@reduxjs/toolkit';

import agentReducer from './slices/agentSlice';
import coworkReducer from './slices/coworkSlice';
import mcpReducer from './slices/mcpSlice';
import modelReducer from './slices/modelSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import skillReducer from './slices/skillSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
