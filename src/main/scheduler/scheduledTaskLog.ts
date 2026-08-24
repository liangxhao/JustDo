const SENSITIVE_MESSAGE_PREVIEW_LENGTH = 30;

function truncateMessage(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= SENSITIVE_MESSAGE_PREVIEW_LENGTH) return value;
  return `${characters.slice(0, SENSITIVE_MESSAGE_PREVIEW_LENGTH).join('')}…`;
}

export function stringifyScheduledTaskLog(value: unknown): string {
  return JSON.stringify(value, (key, nestedValue) => {
    if (key === 'message' && typeof nestedValue === 'string') {
      return truncateMessage(nestedValue);
    }
    return nestedValue;
  });
}
