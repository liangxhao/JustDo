const GOAL_START_PREFIX = '/goal start ';

const FOLLOW_UP_PROMPT_TYPE = 'goal_follow_up';
const FOLLOW_UP_PROMPT_VERSION = 1;

export const GOAL_FOLLOW_UP_PROMPT_TEMPLATE = `The followUpRequest field is the sole task for this goal. Interpret it literally and give it priority over previousGoalContext.

Rules:
1. The previous goal has already been completed.
2. Use the previous goal, conversation history, existing files, and previous outputs only as context for understanding the follow-up request.
3. Do not rewrite, polish, regenerate, or repeat existing outputs unless the follow-up request explicitly asks for it.
4. If the request asks for another, one more, additional, or continued output, create only the requested additional output.
5. Preserve all existing completed work that is outside the follow-up request.
6. Ignore earlier goal-control commands; they are application lifecycle operations, not work requests.
7. After completing the request, summarize only the newly added or changed work and how it was verified.`;

interface GoalFollowUpEnvelope {
  type: typeof FOLLOW_UP_PROMPT_TYPE;
  version: typeof FOLLOW_UP_PROMPT_VERSION;
  followUpRequest: string;
  instructions: string;
  previousGoalContext: string;
}

function encodeJsonStringForGoalCommand(value: string): string {
  // OpenClaw tokenizes /goal arguments on whitespace before persisting the
  // objective. JSON already escapes line breaks and tabs; additionally escape
  // repeated spaces and non-ASCII separators that tokenization would collapse.
  return JSON.stringify(value).replace(
    / {2,}|[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/gu,
    whitespace =>
      Array.from(whitespace, character =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ).join(''),
  );
}

function serializeEnvelope(envelope: GoalFollowUpEnvelope): string {
  return [
    '{"type":',
    encodeJsonStringForGoalCommand(envelope.type),
    ',"version":',
    String(envelope.version),
    ',"followUpRequest":',
    encodeJsonStringForGoalCommand(envelope.followUpRequest),
    ',"instructions":',
    encodeJsonStringForGoalCommand(envelope.instructions),
    ',"previousGoalContext":',
    encodeJsonStringForGoalCommand(envelope.previousGoalContext),
    '}',
  ].join('');
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

export function buildGoalFollowUpPrompt(previousGoal: string, followUpRequest: string): string {
  const envelope: GoalFollowUpEnvelope = {
    type: FOLLOW_UP_PROMPT_TYPE,
    version: FOLLOW_UP_PROMPT_VERSION,
    followUpRequest: followUpRequest.trim(),
    instructions: GOAL_FOLLOW_UP_PROMPT_TEMPLATE,
    previousGoalContext: flattenPreviousGoalContext(previousGoal),
  };
  return `${GOAL_START_PREFIX}${serializeEnvelope(envelope)}`;
}

export function extractGoalFollowUpRequest(text: string): string | null {
  return parseEnvelope(text)?.followUpRequest ?? null;
}
