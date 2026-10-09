import { OpenClawToolName } from '../../plugins/nativeIds';

export const PlanModeGateway = {
  LIST: 'planMode.list',
  RESOLVE: 'planMode.resolve',
  REQUESTED_EVENT: 'plugin.plan-mode.requested',
  RESOLVED_EVENT: 'plugin.plan-mode.resolved',
} as const;

export const PlanModeDecision = {
  IMPLEMENT: 'implement',
  REVISE: 'revise',
  CANCEL: 'cancel',
} as const;

export type PlanModeDecision = (typeof PlanModeDecision)[keyof typeof PlanModeDecision];

export type PlanModeState = {
  enabled: boolean;
  updatedAt: number;
  awaitingReview?: {
    version: 1;
    requestId: string;
    persistedAt: number;
  };
};

export type PlanModeRequest = {
  requestId: string;
  sessionKey: string;
  plan: string;
  title?: string;
};

export type PlanModeInteractionEnvelope = {
  sessionId: string;
  request: {
    requestId: string;
    toolName: typeof OpenClawToolName.PRESENT_PLAN;
    interactionKind: 'plan-approval';
    toolInput: {
      plan: string;
      title?: string;
      sessionKey: string;
      sessionId: string;
    };
  };
};

export const parsePlanModeRequest = (value: unknown): PlanModeRequest | null => {
  if (!isRecord(value)) return null;
  const requestId = readRequiredString(value.requestId);
  const sessionKey = readRequiredString(value.sessionKey);
  const plan = readRequiredString(value.plan);
  const title = value.title === undefined ? undefined : readRequiredString(value.title);
  if (!requestId || !sessionKey || !plan || (value.title !== undefined && !title)) return null;
  return { requestId, sessionKey, plan, ...(title ? { title } : {}) };
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

const readRequiredString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};
