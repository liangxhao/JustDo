import { store } from '../store';
import {
  setAgents,
  setLoading,
} from '../store/slices/agentSlice';

class AgentService {
  async loadAgents(): Promise<void> {
    store.dispatch(setLoading(true));
    try {
      const agents = await window.electron?.agents?.list();
      if (agents) {
        const mappedAgents = agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          model: a.model ?? '',
          enabled: a.enabled,
          isDefault: a.isDefault,
          skillIds: a.skillIds ?? [],
        }));
        store.dispatch(setAgents(mappedAgents));
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      store.dispatch(setLoading(false));
    }
  }

}

export const agentService = new AgentService();
