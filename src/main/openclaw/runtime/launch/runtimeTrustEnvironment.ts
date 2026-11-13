import { X509Certificate } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  applyTrustedCertificateEnv,
  buildTrustedCaBundle,
} from '../../../core/network/trustedCertificates';

const EXTRA_CA_ENV_KEY = 'NODE_EXTRA_CA_CERTS';

async function resolveInheritedCaPath(value: string, runtimeRoot: string): Promise<string | null> {
  const filename = path.resolve(runtimeRoot, value);
  try {
    if (!(await stat(filename)).isFile()) return null;
    const pem = await readFile(filename, 'utf8');
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certificates) return null;
    for (const certificate of certificates) new X509Certificate(certificate);
    return filename;
  } catch {
    return null;
  }
}

export async function applyRuntimeTrustEnvironment(
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  userDataPath: string,
): Promise<void> {
  if (process.platform !== 'win32') {
    applyTrustedCertificateEnv(env, env[EXTRA_CA_ENV_KEY] || buildTrustedCaBundle(userDataPath));
    return;
  }

  let inheritedPath = env[EXTRA_CA_ENV_KEY];
  delete env[EXTRA_CA_ENV_KEY];
  // The Windows preload requires a readable PEM. Normalize the child environment's casing first.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== EXTRA_CA_ENV_KEY) continue;
    inheritedPath ??= env[key];
    delete env[key];
  }

  const caPath = inheritedPath ? await resolveInheritedCaPath(inheritedPath, runtimeRoot) : null;
  if (inheritedPath && !caPath) {
    console.warn('[NetworkTrust] Ignoring unreadable or invalid inherited NODE_EXTRA_CA_CERTS.');
  }
  applyTrustedCertificateEnv(env, caPath ?? buildTrustedCaBundle(userDataPath));
}
