const DEFAULT_CREDENTIAL_RESOLVER_TIMEOUT_MS = 5_000;
const WINDOWS_CREDENTIAL_RESOLVER_TIMEOUT_MS = 60_000;
const CREDENTIAL_RELOAD_OVERHEAD_MS = 30_000;

// PowerShell module analysis and native image compilation can exceed ten seconds
// on a cold or loaded Windows host. Keep the bound aligned with the native runtime.
export const resolveBuiltinCredentialResolverTimeoutMs = (
  platform: NodeJS.Platform = process.platform,
): number => platform === 'win32'
  ? WINDOWS_CREDENTIAL_RESOLVER_TIMEOUT_MS
  : DEFAULT_CREDENTIAL_RESOLVER_TIMEOUT_MS;

// Command ACL verification and snapshot publication also happen inside the RPC.
export const resolveManagedCredentialReloadTimeoutMs = (
  platform: NodeJS.Platform = process.platform,
): number => resolveBuiltinCredentialResolverTimeoutMs(platform) + CREDENTIAL_RELOAD_OVERHEAD_MS;
