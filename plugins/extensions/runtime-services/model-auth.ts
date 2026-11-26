import type {
  OpenClawConfig,
  ProviderPlugin,
  ProviderWrapStreamFnContext,
} from 'openclaw/plugin-sdk/plugin-entry';

import {
  BUILTIN_MODEL_PROVIDER_ID,
  BUILTIN_SECRET_ID,
  BUILTIN_SECRET_SOURCE,
  builtinModelRouteKey,
  CredentialReaderExitCode,
  MODEL_AUTH_SESSION_ENV,
  MODEL_AUTH_SESSION_PATTERN,
  MODEL_AUTH_TYPE_ENV,
} from './contracts/model-auth';

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

const REQUEST_PREPARATION_FAILED = 'Could not prepare the built-in model request.';
const CREDENTIAL_READ_FAILED = 'Could not read the built-in model sign-in data.';
type CredentialReaderFailure = keyof typeof CredentialReaderExitCode;
const CREDENTIAL_READER_MESSAGES: Partial<Record<CredentialReaderFailure, string>> = {
  snapshot_missing: 'The saved built-in model sign-in data is missing.',
  snapshot_read_failed: CREDENTIAL_READ_FAILED,
  snapshot_invalid: 'The saved built-in model sign-in data is invalid.',
  session_mismatch: 'This task belongs to a different built-in model sign-in session.',
  credential_expired: 'The built-in model sign-in is at or near the end of its validity period.',
};

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
  reason as CredentialReaderFailure,
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

function credentialReaderFailure(error: object): CredentialReaderFailure | undefined {
  // Only the locked SDK's exact exec error for our provider carries a reader status.
  if ('scope' in error && error.scope === 'provider' && 'source' in error && error.source === 'exec' &&
      'provider' in error && error.provider === BUILTIN_SECRET_SOURCE &&
      'message' in error && typeof error.message === 'string') {
    return READER_FAILURES.get(error.message);
  }
  return undefined;
}

function describeResolverFailure(resolverStage: ResolverStage, error: unknown) {
  try {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = error.code;
      const allowedCodes = resolverStage === ResolverStage.LoadSdk ? SDK_LOAD_ERROR_CODES : RESOLUTION_ERROR_CODES;
      if (typeof code === 'string' && allowedCodes.has(code)) {
        return {
          resolverStage,
          resolverCode: code,
          resolverReason: resolverStage === ResolverStage.ResolveSecretRef && code === 'SECRET_PROVIDER_UNAVAILABLE'
            ? credentialReaderFailure(error)
            : undefined,
        };
      }
    }
  } catch {
    // Unknown throws can contain getters or proxies. Keep the details private.
  }
  return { resolverStage, resolverCode: 'unknown' };
}

/** Never project provider error text, routes, captured identities or credentials. */
function rejectAuth(reason: AuthFailureReason, resolverFailure?: ReturnType<typeof describeResolverFailure>): never {
  try {
    console.warn(`[BuiltinModelAuth] ${JSON.stringify({
      event: AUTH_FAILURE_EVENT,
      reason,
      ...resolverFailure,
    })}`);
  } catch {
    // Diagnostics must not affect credential rejection or cancellation.
  }
  const readerFailure = resolverFailure?.resolverReason;
  if (readerFailure) {
    throw new Error(CREDENTIAL_READER_MESSAGES[readerFailure] ?? REQUEST_PREPARATION_FAILED);
  }
  const readFailed = reason === AuthFailureReason.InvalidResolvedCredential ||
    resolverFailure?.resolverStage === ResolverStage.ResolveSecretRef;
  throw new Error(readFailed ? CREDENTIAL_READ_FAILED : REQUEST_PREPARATION_FAILED);
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
  const route = builtinModelRouteKey(baseUrl);
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
    else if (builtinModelRouteKey(requestBaseUrl) !== route) rejection = AuthFailureReason.RouteMismatch;
    if (!config || rejection) rejectAuth(rejection ?? AuthFailureReason.MissingProviderConfig);
    let resolved: unknown;
    let resolverStage: ResolverStage = ResolverStage.LoadSdk;
    try {
      const { resolveSecretRefValues } = await loadCredentialSdk();
      resolverStage = ResolverStage.ResolveSecretRef;
      // Resolve a fresh credential on every request, including after renewal or logout.
      const values = await resolveSecretRefValues(
        [{ source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID }],
        { config, manifestRegistry: { plugins: [] } },
      );
      resolved = values.get(SECRET_KEY);
    } catch (error) {
      // Resolver diagnostics can contain paths/secret provider errors. Never expose them
      // through a model error, and never fall back to the old run credential.
      signal?.throwIfAborted();
      rejectAuth(AuthFailureReason.SecretResolutionFailed, describeResolverFailure(resolverStage, error));
    }
    signal?.throwIfAborted();
    if (
      typeof resolved !== 'string' ||
      !resolved ||
      resolved.length > 8192 ||
      /[\s\u0000-\u001f\u007f]/.test(resolved)
    ) {
      rejectAuth(AuthFailureReason.InvalidResolvedCredential);
    }
    return { token: resolved, jwt: authType === 'jwt' };
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
    if (model.provider !== BUILTIN_MODEL_PROVIDER_ID) rejectAuth(AuthFailureReason.ProviderMismatch);
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
