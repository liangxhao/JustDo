export type PlanModeState = {
  enabled: boolean;
  updatedAt: number;
  awaitingReview?: {
    version: 1;
    requestId: string;
    persistedAt: number;
  };
};

export const parsePlanModeState = (value: unknown): PlanModeState => {
  if (!isRecord(value) || value.enabled !== true) return { enabled: false, updatedAt: 0 };
  return {
    enabled: true,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
