const GOAL_START_PREFIX = '/goal start ';

const FOLLOW_UP_PROMPT_TYPE = 'goal_follow_up';
const FOLLOW_UP_PROMPT_VERSION = 1;

interface GoalFollowUpEnvelope {
  type: typeof FOLLOW_UP_PROMPT_TYPE;
  version: typeof FOLLOW_UP_PROMPT_VERSION;
  followUpRequest: string;
  instructions: string;
  previousGoalContext: string;
}

function parseEnvelope(text: string): GoalFollowUpEnvelope | null {
  if (!text.trimStart().startsWith(GOAL_START_PREFIX)) return null;
  const payload = text.trim().slice(GOAL_START_PREFIX.length);
  try {
    const parsed = JSON.parse(payload) as Partial<GoalFollowUpEnvelope>;
    if (
      parsed.type !== FOLLOW_UP_PROMPT_TYPE ||
      parsed.version !== FOLLOW_UP_PROMPT_VERSION ||
      typeof parsed.followUpRequest !== 'string' ||
      typeof parsed.instructions !== 'string' ||
      typeof parsed.previousGoalContext !== 'string'
    ) {
      return null;
    }
    return parsed as GoalFollowUpEnvelope;
  } catch {
    return null;
  }
}

function asGoalStartCommand(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(GOAL_START_PREFIX) ? trimmed : `${GOAL_START_PREFIX}${trimmed}`;
}

export function flattenPreviousGoalContext(previousGoal: string): string {
  const previousEnvelope = parseEnvelope(asGoalStartCommand(previousGoal));
  if (!previousEnvelope) return previousGoal.trim();
  return [
    previousEnvelope.previousGoalContext,
    '',
    'Previously completed follow-up request:',
    previousEnvelope.followUpRequest,
  ].join('\n');
}

export function buildGoalFollowUpPrompt(_previousGoal: string, followUpRequest: string): string {
  // The previous objective remains available in the canonical transcript. Keeping
  // the new Goal literal and concise also ensures OpenClaw's bounded active-goal
  // context describes the task instead of a transport envelope.
  return `${GOAL_START_PREFIX}${followUpRequest.trim()}`;
}

export function extractGoalFollowUpRequest(text: string): string | null {
  const envelope = parseEnvelope(text);
  if (envelope) return envelope.followUpRequest;
  const trimmed = text.trim();
  if (!trimmed.startsWith(GOAL_START_PREFIX)) return null;
  return trimmed.slice(GOAL_START_PREFIX.length).trim() || null;
}
