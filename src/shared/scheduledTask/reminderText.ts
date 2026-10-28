export type ScheduledReminderPrompt = {
  reminderText: string;
  currentTime?: string;
};

const SCHEDULED_REMINDER_PREFIX =
  'A scheduled reminder has been triggered. The reminder content is:';
const SCHEDULED_REMINDER_INTERNAL_INSTRUCTION =
  'Handle this reminder internally. Do not relay it to the user unless explicitly requested.';
const SCHEDULED_REMINDER_RELAY_INSTRUCTION =
  'Please relay this reminder to the user in a helpful and friendly way.';
const CURRENT_TIME_PREFIX = 'Current time:';
const SIMPLE_REMINDER_RE = /^⏰(?:\s|$)/u;

export function parseScheduledReminderPrompt(text: string): ScheduledReminderPrompt | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SCHEDULED_REMINDER_PREFIX)) {
    return null;
  }

  let remainder = trimmed.slice(SCHEDULED_REMINDER_PREFIX.length).trim();
  let currentTime: string | undefined;
  const currentTimeIndex = remainder.lastIndexOf(CURRENT_TIME_PREFIX);
  if (currentTimeIndex >= 0) {
    currentTime =
      remainder.slice(currentTimeIndex + CURRENT_TIME_PREFIX.length).trim() || undefined;
    remainder = remainder.slice(0, currentTimeIndex).trim();
  }

  if (remainder.endsWith(SCHEDULED_REMINDER_INTERNAL_INSTRUCTION)) {
    remainder = remainder.slice(0, -SCHEDULED_REMINDER_INTERNAL_INSTRUCTION.length).trim();
  } else if (remainder.endsWith(SCHEDULED_REMINDER_RELAY_INSTRUCTION)) {
    remainder = remainder.slice(0, -SCHEDULED_REMINDER_RELAY_INSTRUCTION.length).trim();
  }

  if (!remainder) {
    return null;
  }

  return {
    reminderText: remainder,
    ...(currentTime ? { currentTime } : {}),
  };
}

export function isSimpleScheduledReminderText(text: string): boolean {
  return SIMPLE_REMINDER_RE.test(text.trim());
}

export function parseSimpleScheduledReminderText(text: string): ScheduledReminderPrompt | null {
  const trimmed = text.trim();
  if (!isSimpleScheduledReminderText(trimmed)) {
    return null;
  }

  return {
    reminderText: trimmed,
  };
}
