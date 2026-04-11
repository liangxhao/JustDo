import { configureStore } from '@reduxjs/toolkit';
import modelReducer from './slices/modelSlice';
import coworkReducer from './slices/coworkSlice';
import skillReducer from './slices/skillSlice';
import mcpReducer from './slices/mcpSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import agentReducer from './slices/agentSlice';

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
