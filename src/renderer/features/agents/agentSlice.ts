import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';

import { setConfig, updateConfig } from '@/features/cowork/coworkSlice';

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  model: string;
  enabled: boolean;
  deletedAt?: number;
  isDefault: boolean;
  skillIds: string[];
}

interface AgentState {
  agents: AgentSummary[];
  currentAgentId: string;
  loading: boolean;
}

const initialState: AgentState = {
  agents: [],
  currentAgentId: MAIN_USER_AGENT_ID,
  loading: false,
};

const agentSlice = createSlice({
  name: 'agent',
  initialState,
  reducers: {
    setAgents(state, action: PayloadAction<AgentSummary[]>) {
      state.agents = action.payload;
      if (
        !state.agents.some(
          agent => agent.id === state.currentAgentId && agent.enabled && !agent.deletedAt,
        )
      ) {
        state.currentAgentId = MAIN_USER_AGENT_ID;
      }
    },

    setCurrentAgentId(state, action: PayloadAction<string>) {
      state.currentAgentId = state.agents.some(
        agent => agent.id === action.payload && agent.enabled && !agent.deletedAt,
      )
        ? action.payload
        : MAIN_USER_AGENT_ID;
    },

    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },

    updateAgent(state, action: PayloadAction<{ id: string; updates: Partial<AgentSummary> }>) {
      const index = state.agents.findIndex(a => a.id === action.payload.id);
      if (index !== -1) {
        state.agents[index] = { ...state.agents[index], ...action.payload.updates };
        if (
          state.currentAgentId === action.payload.id &&
          (!state.agents[index].enabled || state.agents[index].deletedAt)
        ) {
          state.currentAgentId = MAIN_USER_AGENT_ID;
        }
      }
    },
  },
  extraReducers: builder => {
    builder.addCase(setConfig, (state, action) => {
      if (action.payload.allowMainAgentSwitch !== true) state.currentAgentId = MAIN_USER_AGENT_ID;
    });
    builder.addCase(updateConfig, (state, action) => {
      if (action.payload.allowMainAgentSwitch === false) state.currentAgentId = MAIN_USER_AGENT_ID;
    });
  },
});

export const { setAgents, setCurrentAgentId, setLoading, updateAgent } = agentSlice.actions;

export default agentSlice.reducer;
