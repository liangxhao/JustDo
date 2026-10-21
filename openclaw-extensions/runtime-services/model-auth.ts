import type { ProviderPlugin, ProviderWrapStreamFnContext } from 'openclaw/plugin-sdk/plugin-entry';

import {
  BUILTIN_MODEL_PROVIDER_ID,
  BUILTIN_SECRET_ID,
  BUILTIN_SECRET_SOURCE,
  MODEL_AUTH_SESSION_ENV,
  MODEL_AUTH_SESSION_PATTERN,
  MODEL_AUTH_TYPE_ENV,
} from './contracts/model-auth';

const AUTH_UNAVAILABLE = 'Managed model credentials are unavailable.';
const SECRET_KEY = `exec:${BUILTIN_SECRET_SOURCE}:${BUILTIN_SECRET_ID}`;
const AUTH_HEADERS = new Set(['authorization', BUILTIN_SECRET_ID.toLowerCase()]);

function routeKey(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      return undefined;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return undefined;
  }
}

function replaceAuthHeaders(
  headers: Record<string, string> | undefined,
  token: string,
  jwt: boolean,
) {
  return {
    ...Object.fromEntries(
      Object.entries(headers ?? {}).filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase())),
    ),
    Authorization: `Bearer ${token}`,
    ...(jwt ? { [BUILTIN_SECRET_ID]: token } : {}),
  };
}

/** The captured exec environment binds this stream to one Main-owned login session. */
export function wrapBuiltinModelAuth(ctx: ProviderWrapStreamFnContext) {
  if (ctx.provider !== BUILTIN_MODEL_PROVIDER_ID || !ctx.streamFn) return undefined;
  const inner = ctx.streamFn;
  const provider = ctx.config?.secrets?.providers?.[BUILTIN_SECRET_SOURCE];
  const sessionId =
    provider?.source === 'exec' && 'env' in provider
      ? provider.env?.[MODEL_AUTH_SESSION_ENV]
      : undefined;
  const authType =
    provider?.source === 'exec' && 'env' in provider
      ? provider.env?.[MODEL_AUTH_TYPE_ENV]
      : undefined;
  const baseUrl = routeKey(ctx.config?.models?.providers?.[BUILTIN_MODEL_PROVIDER_ID]?.baseUrl);
  const config = provider
    ? { secrets: { providers: { [BUILTIN_SECRET_SOURCE]: structuredClone(provider) } } }
    : undefined;

  return async (
    model: Parameters<typeof inner>[0],
    context: Parameters<typeof inner>[1],
    options: Parameters<typeof inner>[2],
  ) => {
    options?.signal?.throwIfAborted();
    if (
      !config ||
      !sessionId ||
      !MODEL_AUTH_SESSION_PATTERN.test(sessionId) ||
      (authType !== 'jwt' && authType !== 'api-key') ||
      !baseUrl ||
      model.provider !== BUILTIN_MODEL_PROVIDER_ID ||
      routeKey(model.baseUrl) !== baseUrl
    ) {
      throw new Error(AUTH_UNAVAILABLE);
    }
    let token: string;
    try {
      // A fresh resolver call deliberately has no cache: reload cannot replace a run's
      // captured resolvedApiKey/model.headers, and a settled read must not outlive logout.
      const { resolveSecretRefValues } = await import('openclaw/plugin-sdk/secret-ref-runtime');
      const values = await resolveSecretRefValues(
        [{ source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID }],
        { config, manifestRegistry: { plugins: [] } },
      );
      const resolved = values.get(SECRET_KEY);
      if (
        typeof resolved !== 'string' ||
        !resolved ||
        resolved.length > 8192 ||
        /[\s\u0000-\u001f\u007f]/.test(resolved)
      ) {
        throw new Error(AUTH_UNAVAILABLE);
      }
      token = resolved;
    } catch {
      // Resolver diagnostics can contain paths/secret provider errors. Never expose them
      // through a model error, and never fall back to the old run credential.
      options?.signal?.throwIfAborted();
      throw new Error(AUTH_UNAVAILABLE);
    }
    options?.signal?.throwIfAborted();
    return inner(
      { ...model, headers: replaceAuthHeaders(model.headers, token, authType === 'jwt') },
      context,
      {
        ...options,
        apiKey: token,
        headers: replaceAuthHeaders(options?.headers, token, authType === 'jwt'),
      },
    );
  };
}

export function buildBuiltinModelAuthProvider(): ProviderPlugin {
  return {
    id: BUILTIN_MODEL_PROVIDER_ID,
    label: 'Managed models',
    auth: [],
    wrapStreamFn: wrapBuiltinModelAuth,
    wrapSimpleCompletionStreamFn: wrapBuiltinModelAuth,
  };
}
