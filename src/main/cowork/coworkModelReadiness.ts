import { ProviderName } from '../../shared/providers';
import { mergeModelProviderHeaders } from '../../shared/providers/modelProviderHeaders';
import { getBuiltinModelRequestHeaders } from '../providers/builtinModelCredential';
import { resolveCurrentApiConfig } from '../providers/providerApiConfig';
import { buildOpenAIChatCompletionsUrl, extractApiErrorSnippet } from './coworkModelApi';

const COWORK_MODEL_PROBE_TIMEOUT_MS = 20_000;

type ModelReadinessApiConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName?: string;
  headers?: Record<string, string>;
};

function resolveModelReadinessApiConfig(): {
  config: ModelReadinessApiConfig | null;
  error?: string;
} {
  const resolution = resolveCurrentApiConfig();
  if (!resolution.config) {
    return {
      config: null,
      error: resolution.error,
    };
  }

  return {
    config: {
      apiKey: resolution.config.apiKey,
      baseURL: resolution.config.baseURL,
      model: resolution.config.model,
      providerName: resolution.providerMetadata?.providerName,
      headers: resolution.config.headers,
    },
  };
}

export async function probeCoworkModelReadiness(
  timeoutMs = COWORK_MODEL_PROBE_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { config, error } = resolveModelReadinessApiConfig();
  if (!config) {
    return {
      ok: false,
      error: error || 'API configuration not found.',
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = buildOpenAIChatCompletionsUrl(config.baseURL);
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    headers = mergeModelProviderHeaders(headers, config.headers);
    if (config.providerName === ProviderName.BuiltinModels) {
      const builtinHeaders = getBuiltinModelRequestHeaders();
      if (!builtinHeaders) {
        return { ok: false, error: 'Built-in model authentication is unavailable.' };
      }
      Object.assign(headers, builtinHeaders);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with "ok".' }],
      }),
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const errorSnippet = extractApiErrorSnippet(errorText);
      return {
        ok: false,
        error: errorSnippet
          ? `Model validation failed (${response.status}): ${errorSnippet}`
          : `Model validation failed with status ${response.status}.`,
      };
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutSeconds = Math.ceil(timeoutMs / 1000);
      return {
        ok: false,
        error: `Model validation timed out after ${timeoutSeconds}s.`,
      };
    }
    return {
      ok: false,
      error: `Model validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
