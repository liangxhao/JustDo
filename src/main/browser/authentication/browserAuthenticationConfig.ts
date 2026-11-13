import { BROWSER_AUTHENTICATION_CONFIG } from '../../../config/browserAuthentication';
import { resolveBrowserAuthenticationConfig } from '../../../shared/browser/browserAuthentication';

export const {
  executableName: BROWSER_AUTHENTICATION_EXECUTABLE,
  localEndpoint: BROWSER_AUTHENTICATION_LOCAL_ENDPOINT,
} = resolveBrowserAuthenticationConfig(BROWSER_AUTHENTICATION_CONFIG);

export const BROWSER_AUTHENTICATION_LOCAL_PORT = Number(BROWSER_AUTHENTICATION_LOCAL_ENDPOINT.port || '443');
