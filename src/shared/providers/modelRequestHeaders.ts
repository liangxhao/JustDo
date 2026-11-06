export const OPENAI_REQUEST_USER_AGENT = 'OpenAI/JS 6.39.1';

export const buildOpenAIJsonRequestHeaders = (
  body: string,
  apiKey?: string,
  options: { includeContentLength?: boolean } = {},
): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': OPENAI_REQUEST_USER_AGENT,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  if (options.includeContentLength !== false) {
    headers['Content-Length'] = String(new TextEncoder().encode(body).byteLength);
  }
  return headers;
};
