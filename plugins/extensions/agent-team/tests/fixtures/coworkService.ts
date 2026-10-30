import { vi } from 'vitest';

export const coworkService = {
  ensureSessionSummaries: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(undefined),
  loadSessions: vi.fn().mockResolvedValue(undefined),
  getSessionDetails: vi.fn().mockResolvedValue({ session: null }),
};
