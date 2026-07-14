/**
 * Session title generation through the OpenClaw Gateway.
 */

import { randomUUID } from 'crypto';

import type { GatewayClientLike } from '../gateway/types';

const SESSION_TITLE_MAX_CHARS = 50;
const SESSION_TITLE_FALLBACK = 'New Session';
const SESSION_TITLE_TIMEOUT_MS = 30_000;

export interface TitleGeneratorCallbacks {
  ensureGatewayClientReady(): Promise<void>;
  getGatewayClient(): GatewayClientLike | null;
}

export class GatewayTitleGenerator {
  constructor(private readonly callbacks: TitleGeneratorCallbacks) {}

  async generateTitle(
    userIntent: string | null,
    timeoutMs = SESSION_TITLE_TIMEOUT_MS,
  ): Promise<string> {
    const effectiveTimeout = timeoutMs > 0 ? timeoutMs : SESSION_TITLE_TIMEOUT_MS;

    const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
    const fallbackTitle = this.buildFallbackTitle(
      normalizedInput,
      SESSION_TITLE_FALLBACK,
      SESSION_TITLE_MAX_CHARS,
    );

    if (!normalizedInput) {
      return fallbackTitle;
    }

    // Ensure gateway client is ready
    try {
      await this.callbacks.ensureGatewayClientReady();
    } catch (error) {
      console.warn('[OpenClawRuntime] generateTitle: gateway client not ready:', error);
      return fallbackTitle;
    }

    const client = this.callbacks.getGatewayClient();
    if (!client) {
      console.warn('[OpenClawRuntime] generateTitle: gateway client unavailable');
      return fallbackTitle;
    }

    const prompt = `Generate a short title from this input, keep the same language, return plain text only (no markdown), and keep it within ${SESSION_TITLE_MAX_CHARS} characters: ${normalizedInput}`;

    // Use a temporary session key for title generation with lightweight context
    const titleSessionKey = `title:${randomUUID()}`;
    const idempotencyKey = randomUUID();

    console.log('[OpenClawRuntime] generateTitle: sending request via gateway...');

    let requestPromise: Promise<Record<string, unknown>> | null = null;
    let cleanupScheduled = false;
    const scheduleCleanup = () => {
      if (cleanupScheduled || !requestPromise) return;
      cleanupScheduled = true;
      void requestPromise.then(
        () => this.deleteTitleSession(client, titleSessionKey),
        () => this.deleteTitleSession(client, titleSessionKey),
      );
    };

    try {
      requestPromise = client.request<Record<string, unknown>>(
        'agent',
        {
          message: prompt,
          sessionKey: titleSessionKey,
          idempotencyKey,
          deliver: false,
          bootstrapContextMode: 'lightweight',
        },
        { expectFinal: true },
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout after ${effectiveTimeout}ms`));
        }, effectiveTimeout);
      });

      const result = await Promise.race([requestPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      const resultText = this.extractTitleFromAgentResult(result);
      console.log('[OpenClawRuntime] generateTitle: extracted text=', resultText?.slice(0, 100));

      if (resultText) {
        return this.normalizeTitle(resultText, fallbackTitle, SESSION_TITLE_MAX_CHARS);
      }
    } catch (error) {
      if (this.isTimeoutError(error)) {
        console.debug(
          `[OpenClawRuntime] generateTitle: timed out after ${effectiveTimeout}ms. Using fallback title.`,
        );
        return fallbackTitle;
      }
      console.warn('[OpenClawRuntime] generateTitle: request failed:', error);
    } finally {
      scheduleCleanup();
    }

    return fallbackTitle;
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error && /^timeout(?: after \d+ms)?$/.test(error.message);
  }

  private async deleteTitleSession(client: GatewayClientLike, sessionKey: string): Promise<void> {
    try {
      await client.request('sessions.delete', { key: sessionKey, deleteTranscript: true });
      console.debug(
        '[OpenClawRuntime] generateTitle: deleted temporary title session:',
        sessionKey,
      );
    } catch (error) {
      console.debug(
        '[OpenClawRuntime] generateTitle: temporary title session cleanup failed:',
        error,
      );
    }
  }

  private buildFallbackTitle(input: string, fallback: string, maxChars: number): string {
    if (!input) return fallback;
    const firstLine =
      input
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return this.normalizeTitle(firstLine, fallback, maxChars);
  }

  private normalizeTitle(value: string, fallback: string, maxChars: number): string {
    let title = value.trim();

    // Strip markdown code fences
    const fenced = /```(?:[\w-]+)?\s*([\s\S]*?)```/i.exec(title);
    if (fenced?.[1]) {
      title = fenced[1].trim();
    }

    // Strip markdown formatting
    title = title
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .trim();

    // Extract from "title: xxx" format
    const labeled = /^(?:title|标题)\s*[:：]\s*(.+)$/i.exec(title);
    if (labeled?.[1]) {
      title = labeled[1].trim();
    }

    // Strip quotes
    title = title
      .replace(/^["'`"''']+/, '')
      .replace(/["'`"''']+$/, '')
      .trim();

    // Only use first line (model may return multi-line content)
    title = title.split(/\r?\n/)[0].trim();

    // Strip suffix after dash/hyphen (e.g., "Sorting Algorithms - Part 1/2")
    const dashMatch = title.match(/^(.+?)[ ]+[-—–]/);
    if (dashMatch?.[1]) {
      title = dashMatch[1].trim();
    }

    if (title.length > maxChars) {
      title = title.slice(0, maxChars).trimEnd();
    }

    return title || fallback;
  }

  extractTitleFromAgentResult(result: unknown): string | null {
    return this.extractTitleFromResultImpl(result, 0);
  }

  private extractTitleFromResultImpl(result: unknown, depth: number): string | null {
    if (depth > 5 || !result) return null;

    const obj = result as Record<string, unknown>;

    // Check for Gateway agent final response structure
    if (obj.status === 'ok' && obj.result !== undefined) {
      const innerResult = obj.result as Record<string, unknown>;
      const payloads = innerResult.payloads as unknown[];
      if (Array.isArray(payloads) && payloads.length > 0) {
        const firstPayload = payloads[0] as Record<string, unknown>;
        if (typeof firstPayload?.text === 'string') {
          return firstPayload.text;
        }
      }
      return this.extractTitleFromResultImpl(obj.result, depth + 1);
    }

    if (typeof result === 'string') {
      return result;
    }

    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.result === 'string') return obj.result;
    if (typeof obj.summary === 'string') return obj.summary;

    const payloads = obj.payloads as unknown[];
    if (Array.isArray(payloads) && payloads.length > 0) {
      const firstPayload = payloads[0] as Record<string, unknown>;
      if (typeof firstPayload?.text === 'string') {
        return firstPayload.text;
      }
    }

    const messages = obj.messages as unknown[];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg === 'string') return msg;
        if (msg && typeof msg === 'object') {
          const msgObj = msg as Record<string, unknown>;
          if (typeof msgObj.text === 'string') return msgObj.text;
          if (typeof msgObj.content === 'string') return msgObj.content;
        }
      }
    }

    return null;
  }
}
