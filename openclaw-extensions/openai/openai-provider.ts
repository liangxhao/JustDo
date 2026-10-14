import type { ProviderPlugin } from 'openclaw/plugin-sdk/provider-model-shared';
import { requireServiceBaseUrl } from './intranet-config.js';
import { createOpenAIProvider } from './provider-contract-api.js';
import { resolveAuthoredOpenAIProviderConfig } from './provider-policy-api.js';
import { buildOpenAIResponsesProviderHooks } from './shared.js';
import { resolveUnifiedOpenAIThinkingProfile } from './thinking-policy.js';
/** Retain native replay/stream semantics; Settings owns models and endpoints. */
export function buildOpenAIProvider(): ProviderPlugin {
  return {
    ...createOpenAIProvider(),
    ...buildOpenAIResponsesProviderHooks({ transport: 'sse' }),
    normalizeResolvedModel: ctx => {
      if (ctx.provider.trim().toLowerCase() !== 'openai') return undefined;
      const configured = resolveAuthoredOpenAIProviderConfig(ctx);
      const row = configured?.models?.find(model => model.id === ctx.modelId);
      const baseUrl = requireServiceBaseUrl(row?.baseUrl ?? configured?.baseUrl, 'Model');
      return { ...ctx.model, api: row?.api ?? configured?.api ?? ctx.model.api, baseUrl };
    },
    normalizeTransport: ctx => {
      if (ctx.provider.trim().toLowerCase() !== 'openai') return undefined;
      const configured = resolveAuthoredOpenAIProviderConfig(ctx);
      const row = configured?.models?.find(model => model.id === ctx.modelId);
      return {
        api: row?.api ?? configured?.api ?? ctx.api,
        baseUrl: requireServiceBaseUrl(row?.baseUrl ?? configured?.baseUrl, 'Model'),
      };
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /content_filter.*(?:prompt|input).*(?:too long|exceed)/i.test(errorMessage),
    classifyFailoverReason: ({ code }) => {
      switch (code?.trim().toUpperCase()) {
        case 'SERVER_ERROR':
          return 'server_error';
        case 'INSUFFICIENT_QUOTA':
          return 'billing';
        default:
          return undefined;
      }
    },
    resolveReasoningOutputMode: () => 'native',
    resolveThinkingProfile: ({ modelId, agentRuntime, api, compat, thinkingLevelMap }) =>
      resolveUnifiedOpenAIThinkingProfile(modelId, agentRuntime, compat, api, thinkingLevelMap),
  };
}
