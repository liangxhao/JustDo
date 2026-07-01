const API_ERROR_SNIPPET_MAX_CHARS = 240;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function buildOpenAIChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

export function extractApiErrorSnippet(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const payloadError = payload.error;
    if (typeof payloadError === 'string' && payloadError.trim()) {
      return payloadError.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
    }
    if (payloadError && typeof payloadError === 'object') {
      const message = (payloadError as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
      }
    }
    const payloadMessage = payload.message;
    if (typeof payloadMessage === 'string' && payloadMessage.trim()) {
      return payloadMessage.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
    }
  } catch {
    // Fall through to plain-text extraction when response is not JSON.
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, API_ERROR_SNIPPET_MAX_CHARS);
}

export function extractTextFromOpenAIResponse(payload: unknown): string {
  const record = toRecord(payload);
  if (!record) return '';

  if (typeof record.output_text === 'string') {
    return record.output_text.trim();
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = toRecord(choices[0]);
  const message = toRecord(firstChoice?.message);
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const block = toRecord(part);
        return typeof block?.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}
