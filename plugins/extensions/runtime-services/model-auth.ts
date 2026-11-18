import type {
  OpenClawConfig,
  ProviderPlugin,
  ProviderWrapStreamFnContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import {
  BUILTIN_MODEL_PROVIDER_ID,
  BUILTIN_SECRET_ID,
  BUILTIN_SECRET_SOURCE,
  CredentialReaderExitCode,
  MODEL_AUTH_SESSION_ENV,
  MODEL_AUTH_SESSION_PATTERN,
  MODEL_AUTH_TYPE_ENV,
} from './contracts/model-auth';

const AUTH_UNAVAILABLE = 'Managed model credentials are unavailable.';
const AUTH_FAILURE_EVENT = 'request_credentials_rejected';
const SECRET_KEY = `exec:${BUILTIN_SECRET_SOURCE}:${BUILTIN_SECRET_ID}`;
const AUTH_HEADERS = new Set(['authorization', BUILTIN_SECRET_ID.toLowerCase()]);
const AuthFailureReason = {
  MissingProviderConfig: 'missing_provider_config',
  MissingSession: 'missing_auth_session',
  InvalidSession: 'invalid_auth_session',
  InvalidAuthType: 'invalid_auth_type',
  InvalidConfiguredRoute: 'invalid_configured_route',
  ProviderMismatch: 'provider_mismatch',
  RouteMismatch: 'route_mismatch',
  SecretResolutionFailed: 'secret_resolution_failed',
  InvalidResolvedCredential: 'invalid_resolved_credential',
} as const;
type AuthFailureReason = (typeof AuthFailureReason)[keyof typeof AuthFailureReason];
const ResolverStage = {
  LoadSdk: 'sdk_load',
  ResolveSecretRef: 'secret_ref',
} as const;
type ResolverStage = (typeof ResolverStage)[keyof typeof ResolverStage];
const SDK_LOAD_ERROR_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
  'ERR_REQUIRE_ESM_RACE_CONDITION',
  'ERR_INTERNAL_ASSERTION',
]);
const RESOLUTION_ERROR_CODES = new Set([
  'SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE',
  'SECRET_PROVIDER_INVALID',
  'SECRET_PROVIDER_NOT_CONFIGURED',
  'SECRET_PROVIDER_UNAVAILABLE',
  'SECRET_REF_NOT_FOUND',
  'SECRET_REF_POLICY_DENIED',
  'SECRET_REF_INVALID',
  'SECRET_REF_REDACTED_VALUE',
  'SECRET_REF_PROVIDER_ERROR',
  'SECRET_REF_PROVIDER_CONTRACT',
]);
const READER_FAILURES = new Map(Object.entries(CredentialReaderExitCode).map(([reason, code]) => [
  `Exec provider "${BUILTIN_SECRET_SOURCE}" exited with code ${code}.`,
  reason,
]));

let credentialSdk: Promise<typeof import('openclaw/plugin-sdk/secret-ref-runtime')> | undefined;

function loadCredentialSdk() {
  return credentialSdk ??= import('openclaw/plugin-sdk/secret-ref-runtime').catch(error => {
    credentialSdk = undefined;
    throw error;
  });
}

// Start loading under the plugin loader's SDK aliases. Keep the provider's
// credential guard registered even if loading the SDK fails.
void loadCredentialSdk().catch(() => undefined);

function credentialReaderFailure(error: object): string | undefined {
  // Only the locked SDK's exact exec error for our provider carries a reader status.
  if ('scope' in error && error.scope === 'provider' && 'source' in error && error.source === 'exec' &&
      'provider' in error && error.provider === BUILTIN_SECRET_SOURCE &&
      'message' in error && typeof error.message === 'string') {
    return READER_FAILURES.get(error.message);
  }
  return undefined;
}

/** Never project provider error text, routes, captured identities or credentials. */
function logAuthFailure(reason: AuthFailureReason, error?: unknown, resolverStage?: ResolverStage): void {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const allowedCodes = resolverStage === ResolverStage.LoadSdk ? SDK_LOAD_ERROR_CODES : RESOLUTION_ERROR_CODES;
    const resolverReason = resolverStage === ResolverStage.ResolveSecretRef &&
      code === 'SECRET_PROVIDER_UNAVAILABLE' && error && typeof error === 'object'
      ? credentialReaderFailure(error)
      : undefined;
    console.warn(`[BuiltinModelAuth] ${JSON.stringify({
      event: AUTH_FAILURE_EVENT,
      reason,
      ...(reason === AuthFailureReason.SecretResolutionFailed ? {
        resolverStage,
        resolverCode: typeof code === 'string' && allowedCodes.has(code) ? code : 'unknown',
        resolverReason,
      } : {}),
    })}`);
  } catch {
    // Diagnostics must not affect credential rejection or cancellation.
  }
}

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

export function replaceBuiltinAuthHeaders(
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

/** The captured exec environment binds each request to one Main-owned login session. */
export function captureBuiltinModelRequestAuth(
  sourceConfig: OpenClawConfig | undefined,
  baseUrl: string | undefined,
) {
  const provider = sourceConfig?.secrets?.providers?.[BUILTIN_SECRET_SOURCE];
  const sessionId =
    provider?.source === 'exec' && 'env' in provider
      ? provider.env?.[MODEL_AUTH_SESSION_ENV]
      : undefined;
  const authType =
    provider?.source === 'exec' && 'env' in provider
      ? provider.env?.[MODEL_AUTH_TYPE_ENV]
      : undefined;
  const route = routeKey(baseUrl);
  const config = provider
    ? { secrets: { providers: { [BUILTIN_SECRET_SOURCE]: structuredClone(provider) } } }
    : undefined;

  return async (requestBaseUrl: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    let rejection: AuthFailureReason | undefined;
    if (!config) rejection = AuthFailureReason.MissingProviderConfig;
    else if (!sessionId) rejection = AuthFailureReason.MissingSession;
    else if (!MODEL_AUTH_SESSION_PATTERN.test(sessionId)) rejection = AuthFailureReason.InvalidSession;
    else if (authType !== 'jwt' && authType !== 'api-key') rejection = AuthFailureReason.InvalidAuthType;
    else if (!route) rejection = AuthFailureReason.InvalidConfiguredRoute;
    else if (routeKey(requestBaseUrl) !== route) rejection = AuthFailureReason.RouteMismatch;
    if (!config || rejection) {
      logAuthFailure(rejection ?? AuthFailureReason.MissingProviderConfig);
      throw new Error(AUTH_UNAVAILABLE);
    }
    let token: string;
    let failureReason: AuthFailureReason = AuthFailureReason.SecretResolutionFailed;
    let resolverStage: ResolverStage = ResolverStage.LoadSdk;
    try {
      const { resolveSecretRefValues } = await loadCredentialSdk();
      resolverStage = ResolverStage.ResolveSecretRef;
      // Resolve a fresh credential on every request, including after renewal or logout.
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
        failureReason = AuthFailureReason.InvalidResolvedCredential;
        throw new Error(AUTH_UNAVAILABLE);
      }
      token = resolved;
    } catch (error) {
      // Resolver diagnostics can contain paths/secret provider errors. Never expose them
      // through a model error, and never fall back to the old run credential.
      signal?.throwIfAborted();
      logAuthFailure(failureReason, error, resolverStage);
      throw new Error(AUTH_UNAVAILABLE);
    }
    signal?.throwIfAborted();
    return { token, jwt: authType === 'jwt' };
  };
}

export function wrapBuiltinModelAuth(ctx: ProviderWrapStreamFnContext) {
  if (ctx.provider !== BUILTIN_MODEL_PROVIDER_ID || !ctx.streamFn) return undefined;
  const inner = ctx.streamFn;
  const readCredential = captureBuiltinModelRequestAuth(
    ctx.config,
    ctx.config?.models?.providers?.[BUILTIN_MODEL_PROVIDER_ID]?.baseUrl,
  );
  return async (
    model: Parameters<typeof inner>[0],
    context: Parameters<typeof inner>[1],
    options: Parameters<typeof inner>[2],
  ) => {
    options?.signal?.throwIfAborted();
    if (model.provider !== BUILTIN_MODEL_PROVIDER_ID) {
      logAuthFailure(AuthFailureReason.ProviderMismatch);
      throw new Error(AUTH_UNAVAILABLE);
    }
    const { token, jwt } = await readCredential(model.baseUrl, options?.signal);
    options?.signal?.throwIfAborted();
    return inner(
      { ...model, headers: replaceBuiltinAuthHeaders(model.headers, token, jwt) },
      context,
      {
        ...options,
        apiKey: token,
        headers: replaceBuiltinAuthHeaders(options?.headers, token, jwt),
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
