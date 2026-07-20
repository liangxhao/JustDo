import { applyTrustedCertificateEnv } from './trustedCertificates';

const LOOPBACK_BYPASSES = ['localhost', '127.0.0.1', '::1'] as const;

export type GatewayProxyEnvironment = {
  proxyUrl: string;
  caBundlePath: string;
};

const mergeNoProxy = (env: NodeJS.ProcessEnv, explicitBypassEntries: readonly string[]): string =>
  Array.from(
    new Set(
      [env.NO_PROXY, env.no_proxy]
        .flatMap(value => (value || '').split(','))
        .map(value => value.trim())
        .filter(Boolean)
        .concat(LOOPBACK_BYPASSES, explicitBypassEntries),
    ),
  ).join(',');

/** Builds one immutable-by-convention environment snapshot for a Gateway generation. */
export const buildGatewayNetworkEnvironment = (
  baseEnv: NodeJS.ProcessEnv,
  outboundProxy: GatewayProxyEnvironment | null,
  bypassEntries: readonly string[] = [],
): NodeJS.ProcessEnv => {
  const env = { ...baseEnv };
  if (!outboundProxy) {
    return env;
  }

  env.HTTP_PROXY = outboundProxy.proxyUrl;
  env.HTTPS_PROXY = outboundProxy.proxyUrl;
  env.http_proxy = outboundProxy.proxyUrl;
  env.https_proxy = outboundProxy.proxyUrl;
  env.NODE_USE_ENV_PROXY = '1';
  const noProxy = mergeNoProxy(env, bypassEntries);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  applyTrustedCertificateEnv(env, outboundProxy.caBundlePath);
  return env;
};
