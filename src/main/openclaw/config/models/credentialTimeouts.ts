const DEFAULT_CREDENTIAL_RESOLVER_TIMEOUT_MS = 5_000;
const WINDOWS_CREDENTIAL_RESOLVER_TIMEOUT_MS = 60_000;
const CREDENTIAL_RELOAD_OVERHEAD_MS = 30_000;

// The reader executes Node directly. Native Windows ACL verification can still
// invoke system security tools on a cold host, so retain its existing bound.
export const resolveBuiltinCredentialResolverTimeoutMs = (
  platform: NodeJS.Platform = process.platform,
): number => platform === 'win32'
  ? WINDOWS_CREDENTIAL_RESOLVER_TIMEOUT_MS
  : DEFAULT_CREDENTIAL_RESOLVER_TIMEOUT_MS;

// Command ACL verification and snapshot publication also happen inside the RPC.
export const resolveManagedCredentialReloadTimeoutMs = (
  platform: NodeJS.Platform = process.platform,
): number => resolveBuiltinCredentialResolverTimeoutMs(platform) + CREDENTIAL_RELOAD_OVERHEAD_MS;
