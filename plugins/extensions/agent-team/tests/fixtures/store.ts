import { vi } from 'vitest';

export const emptySnapshot = {
  cowork: { sessions: [], pendingInteractions: [], draftPrompts: {}, draftMessageQuotes: {} },
  agent: { agents: [] },
};
export const store = {
  getState: () => emptySnapshot,
  subscribe: (_listener: () => void) => () => undefined,
  dispatch: vi.fn(),
};
