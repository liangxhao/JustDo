import { BROWSER_AUTHENTICATION_CONFIG } from '../../../config/browserAuthentication';
import { resolveBrowserAuthenticationConfig } from '../../../shared/browser/browserAuthentication';

export const {
  executableName: BROWSER_AUTHENTICATION_EXECUTABLE,
  providerOrigin: BROWSER_AUTHENTICATION_PROVIDER_ORIGIN,
} = resolveBrowserAuthenticationConfig(BROWSER_AUTHENTICATION_CONFIG);

function credentialFreeHttpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function getBrowserAuthenticationProviderUrl(value: string): URL | null {
  const url = credentialFreeHttpsUrl(value);
  return url?.origin === BROWSER_AUTHENTICATION_PROVIDER_ORIGIN ? url : null;
}

export function normalizeBrowserAuthenticationEntry(value: unknown): string | null {
  const url = credentialFreeHttpsUrl(value);
  if (
    !url ||
    !BROWSER_AUTHENTICATION_PROVIDER_ORIGIN ||
    url.origin === BROWSER_AUTHENTICATION_PROVIDER_ORIGIN
  )
    return null;
  url.hash = '';
  return url.href;
}
