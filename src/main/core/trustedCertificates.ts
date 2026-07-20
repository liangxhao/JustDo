import fs from 'fs';
import path from 'path';
import tls from 'tls';

const TRUST_DIRECTORY_RELATIVE_PATH = path.join('outbound-header-proxy', 'certs');
const LEGACY_TRUST_DIRECTORY_NAME = 'network-trust';
const TRUSTED_CA_BUNDLE_NAME = 'trusted-ca-bundle.pem';
const OUTBOUND_HEADER_TRUSTED_CA_BUNDLE_NAME = 'gateway-trusted-ca-bundle.pem';
const USE_SYSTEM_CA_OPTION = '--use-system-ca';

const TRUST_ENV_KEYS = [
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'SSL_CERT_FILE',
  'PIP_CERT',
] as const;

type TrustEnvKey = (typeof TRUST_ENV_KEYS)[number];
type TrustEnvSnapshot = Record<TrustEnvKey, string | undefined>;

const originalTrustEnv: TrustEnvSnapshot = TRUST_ENV_KEYS.reduce((acc, key) => {
  acc[key] = process.env[key];
  return acc;
}, {} as TrustEnvSnapshot);

const uniqueCertificates = (certs: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cert of certs) {
    const normalized = cert.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(`${normalized}\n`);
  }
  return result;
};

const readCertificateFile = (filePath: string): string | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
};

const appendNodeOption = (value: string | undefined, option: string): string => {
  const tokens = (value || '').split(/\s+/).filter(Boolean);
  return tokens.includes(option) ? tokens.join(' ') : [...tokens, option].join(' ');
};

const cleanupLegacyTrustedCaBundle = (userDataPath: string, currentBundlePath: string): void => {
  const legacyBundlePath = path.join(
    userDataPath,
    LEGACY_TRUST_DIRECTORY_NAME,
    TRUSTED_CA_BUNDLE_NAME,
  );
  if (legacyBundlePath === currentBundlePath || !fs.existsSync(legacyBundlePath)) {
    return;
  }

  try {
    fs.rmSync(legacyBundlePath, { force: true });
    fs.rmdirSync(path.dirname(legacyBundlePath));
  } catch {
    // Best-effort cleanup only. Leave any user-added files in the legacy directory alone.
  }
};

export const enableSystemCaForCurrentProcess = (): void => {
  if (
    typeof tls.getCACertificates !== 'function' ||
    typeof tls.setDefaultCACertificates !== 'function'
  ) {
    return;
  }

  try {
    const current = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    if (system.length === 0) {
      return;
    }
    tls.setDefaultCACertificates(uniqueCertificates([...current, ...system]));
    console.log(
      `[NetworkTrust] Enabled system CA certificates for current process (${system.length}).`,
    );
  } catch (error) {
    console.warn('[NetworkTrust] Failed to enable system CA certificates:', error);
  }
};

const buildTrustedCaBundleFile = (
  userDataPath: string,
  bundleName: string,
  additionalCertificatePaths: readonly string[],
): string | null => {
  if (typeof tls.getCACertificates !== 'function') {
    return null;
  }

  try {
    const defaultCerts = tls.getCACertificates('default');
    const systemCerts = tls.getCACertificates('system');
    const extraCerts = tls.getCACertificates('extra');
    const additionalCerts = additionalCertificatePaths
      .map(readCertificateFile)
      .filter((value): value is string => value !== null);
    const certs = uniqueCertificates([
      ...defaultCerts,
      ...systemCerts,
      ...extraCerts,
      ...additionalCerts,
    ]);
    if (certs.length === 0) {
      return null;
    }

    const trustDir = path.join(userDataPath, TRUST_DIRECTORY_RELATIVE_PATH);
    fs.mkdirSync(trustDir, { recursive: true });
    const bundlePath = path.join(trustDir, bundleName);
    const content = `${certs.join('\n')}\n`;
    if (!fs.existsSync(bundlePath) || fs.readFileSync(bundlePath, 'utf8') !== content) {
      fs.writeFileSync(bundlePath, content, 'utf8');
    }
    cleanupLegacyTrustedCaBundle(userDataPath, bundlePath);
    return bundlePath;
  } catch (error) {
    console.warn('[NetworkTrust] Failed to build trusted CA bundle:', error);
    return null;
  }
};

export const buildTrustedCaBundle = (userDataPath: string): string | null =>
  buildTrustedCaBundleFile(userDataPath, TRUSTED_CA_BUNDLE_NAME, []);

/** Builds the Gateway trust bundle without sharing the baseline bundle's output file. */
export const buildOutboundHeaderTrustedCaBundle = (
  userDataPath: string,
  caCertificatePath: string,
): string | null =>
  buildTrustedCaBundleFile(userDataPath, OUTBOUND_HEADER_TRUSTED_CA_BUNDLE_NAME, [
    caCertificatePath,
  ]);

export const applyTrustedCertificateEnv = (
  env: NodeJS.ProcessEnv,
  caBundlePath: string | null,
): void => {
  env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, USE_SYSTEM_CA_OPTION);
  if (!caBundlePath) {
    return;
  }

  env.NODE_EXTRA_CA_CERTS = caBundlePath;
  env.REQUESTS_CA_BUNDLE = caBundlePath;
  env.CURL_CA_BUNDLE = caBundlePath;
  env.SSL_CERT_FILE = caBundlePath;
  env.PIP_CERT = caBundlePath;
};

export const restoreTrustedCertificateEnv = (env: NodeJS.ProcessEnv): void => {
  for (const key of TRUST_ENV_KEYS) {
    const originalValue = originalTrustEnv[key];
    if (typeof originalValue === 'string') {
      env[key] = originalValue;
    } else {
      delete env[key];
    }
  }
};
