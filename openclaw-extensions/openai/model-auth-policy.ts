import type {
  ProviderModelAuthPolicyContext,
  ProviderModelAuthPolicy,
} from 'openclaw/plugin-sdk/provider-model-types';
/** Public account OAuth is not an intranet service credential. */
export function resolveModelAuthPolicy(
  ctx: ProviderModelAuthPolicyContext,
): ProviderModelAuthPolicy | undefined {
  if (ctx.provider.trim().toLowerCase() !== 'openai') return undefined;
  return {
    authRequirement: ctx.mode === 'none' ? null : 'api-key',
    compatible: ctx.mode === 'none' || ctx.mode === 'api-key' || ctx.mode === 'api_key',
    incompatibilityReason: 'Configure credentials for the selected OpenAI-compatible service.',
  };
}
