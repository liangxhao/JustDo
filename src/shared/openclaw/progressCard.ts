export const ProgressCardStepStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const;

export type ProgressCardStepStatus =
  (typeof ProgressCardStepStatus)[keyof typeof ProgressCardStepStatus];

export interface ProgressCardStep {
  step: string;
  status: ProgressCardStepStatus;
}

export interface ProgressCard {
  sessionKey: string;
  revision: number;
  updatedAt: number;
  markdown?: string;
  steps?: ProgressCardStep[];
}

export interface ProgressCardViewState {
  sessionKey: string;
  card: ProgressCard | null;
  loading: boolean;
  available: boolean;
  error: 'access-denied' | 'unavailable' | null;
}

export interface ProgressCardChangedEvent {
  sessionKey: string;
  revision: number | null;
}

const MAX_PROGRESS_CARD_STEPS = 50;
const MAX_PROGRESS_CARD_STEP_CHARS = 512;
const MAX_PROGRESS_CARD_MARKDOWN_CHARS = 8_192;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const STEP_STATUSES = new Set<ProgressCardStepStatus>(Object.values(ProgressCardStepStatus));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseSteps = (candidate: unknown): ProgressCardStep[] | undefined | null => {
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > MAX_PROGRESS_CARD_STEPS) {
    return null;
  }

  let inProgressCount = 0;
  const steps: ProgressCardStep[] = [];
  for (const candidateStep of candidate) {
    if (!isRecord(candidateStep)) return null;
    const step = typeof candidateStep.step === 'string' ? candidateStep.step : '';
    const status = candidateStep.status;
    if (
      !step.trim() ||
      step.length > MAX_PROGRESS_CARD_STEP_CHARS ||
      typeof status !== 'string' ||
      !STEP_STATUSES.has(status as ProgressCardStepStatus)
    ) {
      return null;
    }
    if (status === ProgressCardStepStatus.InProgress) {
      inProgressCount += 1;
      if (inProgressCount > 1) return null;
    }
    steps.push({ step, status: status as ProgressCardStepStatus });
  }
  return steps;
};

export const parseProgressCardGetResult = (
  candidate: unknown,
  expectedSessionKey: string,
): ProgressCard | null | undefined => {
  if (!isRecord(candidate) || !Object.prototype.hasOwnProperty.call(candidate, 'card')) {
    return undefined;
  }
  if (candidate.card === null) return null;
  if (!isRecord(candidate.card)) return undefined;

  const card = candidate.card;
  const rawMarkdown = card.markdown;
  let markdown: string | undefined;
  if (typeof rawMarkdown === 'string') {
    markdown = rawMarkdown;
  } else if (rawMarkdown !== undefined) {
    return undefined;
  }
  const steps = parseSteps(card.steps);
  if (
    card.sessionKey !== expectedSessionKey ||
    !Number.isInteger(card.revision) ||
    (card.revision as number) < 1 ||
    !Number.isInteger(card.updatedAt) ||
    Math.abs(card.updatedAt as number) > MAX_DATE_TIMESTAMP_MS ||
    (markdown?.length ?? 0) > MAX_PROGRESS_CARD_MARKDOWN_CHARS ||
    steps === null ||
    (markdown === undefined && steps === undefined) ||
    (!markdown?.trim() && steps === undefined)
  ) {
    return undefined;
  }

  return {
    sessionKey: expectedSessionKey,
    revision: card.revision as number,
    updatedAt: card.updatedAt as number,
    ...(markdown ? { markdown } : {}),
    ...(steps ? { steps } : {}),
  };
};

export const parseProgressCardChangedEvent = (
  candidate: unknown,
): ProgressCardChangedEvent | null => {
  if (!isRecord(candidate)) return null;
  const sessionKey = typeof candidate.sessionKey === 'string' ? candidate.sessionKey.trim() : '';
  const revision = candidate.revision;
  if (
    !sessionKey ||
    (revision !== null &&
      (!Number.isInteger(revision) || (typeof revision === 'number' && revision < 1)))
  ) {
    return null;
  }
  return { sessionKey, revision: revision as number | null };
};

export const progressCardIsComplete = (card: ProgressCard): boolean =>
  !!card.steps?.length && card.steps.every(step => step.status === ProgressCardStepStatus.Completed);
