import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  model: string;
  enabled: boolean;
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
  currentAgentId: 'main',
  loading: false,
};

const agentSlice = createSlice({
  name: 'agent',
  initialState,
  reducers: {
    setAgents(state, action: PayloadAction<AgentSummary[]>) {
      state.agents = action.payload;
    },

    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },

    updateAgent(state, action: PayloadAction<{ id: string; updates: Partial<AgentSummary> }>) {
      const index = state.agents.findIndex((a) => a.id === action.payload.id);
      if (index !== -1) {
        state.agents[index] = { ...state.agents[index], ...action.payload.updates };
      }
    },

  },
});

export const {
  setAgents,
  setLoading,
  updateAgent,
} = agentSlice.actions;

export default agentSlice.reducer;
