import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANAGED_PROVIDER_SECRET_SOURCE = 'justdo-model-providers';
const SECRET_FILE_NAME = 'model-provider-secrets.json';
const BUILTIN_KEY = 'BUILTIN_MODELS';
let windowsUserSid: string | undefined;
export function restrictCredentialFile(filePath: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
    return;
  }
  const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const options = { windowsHide: true, timeout: 5_000, encoding: 'utf8' as const };
  if (!windowsUserSid) {
    const identity = execFileSync(path.join(systemDirectory, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options);
    windowsUserSid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!windowsUserSid) throw new Error('Unable to identify the credential file owner.');
  }
  execFileSync(path.join(systemDirectory, 'icacls.exe'), [
    filePath, '/inheritance:r', '/grant:r',
    `*${windowsUserSid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F',
  ], options);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Compare provider credential references without reading their secret values. */
export function providerSecretIdentity(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    isRecord(value) && value.source === 'file' &&
    value.provider === MANAGED_PROVIDER_SECRET_SOURCE && typeof value.id === 'string'
  ) return `${MANAGED_PROVIDER_SECRET_SOURCE}:${value.id}`;
  return '';
}

export const managedProviderSecretRef = (providerId: string): Record<string, string> => ({
  source: 'file',
  provider: MANAGED_PROVIDER_SECRET_SOURCE,
  id: `/${providerId}`,
});

/** Publish credentials before the config that references them; never put values in config. */
export function syncProviderSecretFile(
  config: Record<string, unknown>,
  stateDir: string,
  apiKeys: Record<string, string>,
): { config: Record<string, unknown>; secretsChanged: boolean } {
  const next = structuredClone(config);
  const providers = isRecord(next.models) && isRecord(next.models.providers)
    ? next.models.providers : {};
  const keys: Record<string, string> = {};
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider)) continue;
    const identity = providerSecretIdentity(provider.apiKey);
    const filePrefix = `${MANAGED_PROVIDER_SECRET_SOURCE}:/`;
    const id = identity.startsWith(filePrefix) ? identity.slice(filePrefix.length) : undefined;
    if (!id || id === BUILTIN_KEY) continue;
    if (!apiKeys[id]) throw new Error('A managed model provider credential is unavailable.');
    keys[id] = apiKeys[id];
    provider.apiKey = managedProviderSecretRef(id);
  }

  const filePath = path.join(stateDir, SECRET_FILE_NAME);
  const secrets = isRecord(next.secrets) ? next.secrets : {};
  const sources = isRecord(secrets.providers) ? secrets.providers : {};
  if (Object.keys(keys).length > 0) {
    next.secrets = {
      ...secrets,
      providers: {
        ...sources,
        [MANAGED_PROVIDER_SECRET_SOURCE]: { source: 'file', path: filePath, mode: 'json' },
      },
    };
  }
  const content = `${JSON.stringify(Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
  if (!Object.keys(keys).length && !fs.existsSync(filePath)) return { config: next, secretsChanged: false };
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
    return { config: next, secretsChanged: false };
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    // Tighten Windows ACLs while the file is empty, before writing any secret.
    fs.writeFileSync(temporaryPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    restrictCredentialFile(temporaryPath);
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return { config: next, secretsChanged: true };
}
