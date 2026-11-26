// Existing native compatibility identities; new protocol fields remain product-neutral.
export const BUILTIN_MODEL_PROVIDER_ID = 'builtin_models';
export const BUILTIN_SECRET_SOURCE = 'justdo_login';
export const BUILTIN_SECRET_ID = 'X-ACCESS-JWT';
export const MODEL_AUTH_SESSION_ENV = 'MODEL_AUTH_SESSION_ID';
export const MODEL_AUTH_TYPE_ENV = 'MODEL_AUTH_TYPE';
export const MODEL_AUTH_SESSION_PATTERN = /^[a-f0-9]{32}$/;

export function builtinModelRouteKey(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href))
      return undefined;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return undefined;
  }
}

// The exec SecretRef reports a nonzero exit status but does not relay reader stderr.
export const CredentialReaderExitCode = {
  invalid_request: 41,
  snapshot_missing: 42,
  snapshot_read_failed: 43,
  snapshot_invalid: 44,
  session_mismatch: 45,
  auth_type_mismatch: 46,
  credential_expired: 47,
} as const;
