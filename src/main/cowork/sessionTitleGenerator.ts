import {
  buildOpenAIChatCompletionsUrl,
  extractApiErrorSnippet,
  extractTextFromOpenAIResponse,
} from './coworkModelApi';

const SESSION_TITLE_MAX_CHARS = 50;
const SESSION_TITLE_SOURCE_MAX_CHARS = 2_000;
const SESSION_TITLE_FALLBACK = 'New Session';
const SESSION_TITLE_TIMEOUT_MS = 30_000;
const SESSION_TITLE_MAX_TOKENS = 4_096;
const SESSION_TITLE_SYSTEM_PROMPT =
  'Generate a short title for this conversation. Keep the same language as the user, return plain text only (no markdown), and keep it within 50 characters.';

export type SessionTitleApiConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

export interface SessionTitleGeneratorCallbacks {
  resolveApiConfig(): { config: SessionTitleApiConfig | null; error?: string };
  fetch?: typeof fetch;
}

export class SessionTitleGenerator {
  constructor(private readonly callbacks: SessionTitleGeneratorCallbacks) {}

  async generateTitle(
    userIntent: string | null,
    timeoutMs = SESSION_TITLE_TIMEOUT_MS,
  ): Promise<string> {
    const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
    const fallbackTitle = this.buildFallbackTitle(normalizedInput);
    if (!normalizedInput) return fallbackTitle;

    const resolution = this.callbacks.resolveApiConfig();
    if (!resolution.config) {
      console.debug(
        '[SessionTitleGenerator] current model is unavailable; using fallback title:',
        resolution.error,
      );
      return fallbackTitle;
    }

    const effectiveTimeout = timeoutMs > 0 ? timeoutMs : SESSION_TITLE_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const { apiKey, baseURL, model } = resolution.config;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await (this.callbacks.fetch ?? fetch)(
        buildOpenAIChatCompletionsUrl(baseURL),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            max_tokens: SESSION_TITLE_MAX_TOKENS,
            messages: [
              { role: 'system', content: SESSION_TITLE_SYSTEM_PROMPT },
              {
                role: 'user',
                content: normalizedInput.slice(0, SESSION_TITLE_SOURCE_MAX_CHARS),
              },
            ],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const errorSnippet = extractApiErrorSnippet(responseText);
        console.warn(
          `[SessionTitleGenerator] model request failed with status ${response.status}${errorSnippet ? `: ${errorSnippet}` : ''}`,
        );
        return fallbackTitle;
      }

      const resultText = extractTextFromOpenAIResponse(await response.json());
      return resultText ? this.normalizeTitle(resultText, fallbackTitle) : fallbackTitle;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.debug(
          `[SessionTitleGenerator] model request timed out after ${effectiveTimeout}ms; using fallback title.`,
        );
      } else {
        console.warn('[SessionTitleGenerator] model request failed:', error);
      }
      return fallbackTitle;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildFallbackTitle(input: string): string {
    if (!input) return SESSION_TITLE_FALLBACK;
    const firstLine =
      input
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean) || '';
    return this.normalizeTitle(firstLine, SESSION_TITLE_FALLBACK);
  }

  private normalizeTitle(value: string, fallback: string): string {
    let title = value.trim();

    const fenced = /```(?:[\w-]+)?\s*([\s\S]*?)```/i.exec(title);
    if (fenced?.[1]) title = fenced[1].trim();

    title = title
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .trim();

    title = title
      .replace(/^["'`“‘]+/, '')
      .replace(/["'`”’]+$/, '')
      .trim()
      .split(/\r?\n/)[0]
      .trim();

    const labeled = /^(?:title|标题)\s*[:：]\s*(.+)$/i.exec(title);
    if (labeled?.[1]) title = labeled[1].trim();

    const dashMatch = title.match(/^(.+?)[ ]+[-—–]/);
    if (dashMatch?.[1]) title = dashMatch[1].trim();

    if (title.length > SESSION_TITLE_MAX_CHARS) {
      title = title.slice(0, SESSION_TITLE_MAX_CHARS).trimEnd();
    }
    return title || fallback;
  }
}
