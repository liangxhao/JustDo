import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { t } from '../../core/i18n';
import { restrictCredentialFile } from '../../openclaw/config/providerSecretFile';

export const EXTENSION_SECRET_PROVIDER = 'justdo-extension-secrets';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only declared structured secret inputs use the host's SecretRef resolution. */
export function isExtensionSecretReferenceField(
  manifest: Record<string, unknown>,
  fieldPath: string,
): boolean {
  const contracts = isRecord(manifest.configContracts) ? manifest.configContracts : {};
  const inputs = isRecord(contracts.secretInputs) ? contracts.secretInputs : {};
  if (
    !Array.isArray(inputs.paths) ||
    !inputs.paths.some(
      entry => isRecord(entry) && entry.path === fieldPath && entry.expected === 'string',
    )
  )
    return false;
  let schema: unknown = manifest.configSchema;
  for (const segment of fieldPath.split('.')) {
    schema =
      isRecord(schema) && isRecord(schema.properties) ? schema.properties[segment] : undefined;
  }
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) return false;
  const properties = schema.properties;
  return ['source', 'provider', 'id'].every(key => key in properties);
}

/** Write a restricted file before publishing references; never return secret values to UI. */
export function saveExtensionSecrets(
  config: Record<string, unknown>,
  stateDir: string,
  extensionId: string,
  values: Record<string, string>,
): { references: Record<string, Record<string, string>>; changed: boolean } {
  if (Object.keys(values).length === 0) return { references: {}, changed: false };
  const filePath = path.join(stateDir, 'extension-secrets.json');
  let stored: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw new Error(t('extensionCredentialStoreUnavailable'));
    }
    if (!isRecord(parsed)) throw new Error(t('extensionCredentialStoreUnavailable'));
    stored = parsed;
  }
  const references: Record<string, Record<string, string>> = {};
  let changed = false;
  for (const [fieldPath, value] of Object.entries(values)) {
    const id = createHash('sha256')
      .update(JSON.stringify([extensionId, fieldPath]))
      .digest('hex');
    changed ||= stored[id] !== value;
    stored[id] = value;
    references[fieldPath] = { source: 'file', provider: EXTENSION_SECRET_PROVIDER, id: `/${id}` };
  }
  if (changed) {
    const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporaryPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      restrictCredentialFile(temporaryPath);
      fs.writeFileSync(temporaryPath, `${JSON.stringify(stored)}\n`, 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } catch {
      throw new Error(t('extensionCredentialStoreWriteFailed'));
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
  const secrets = isRecord(config.secrets) ? config.secrets : {};
  const providers = isRecord(secrets.providers) ? secrets.providers : {};
  config.secrets = {
    ...secrets,
    providers: {
      ...providers,
      [EXTENSION_SECRET_PROVIDER]: { source: 'file', path: filePath, mode: 'json' },
    },
  };
  return { references, changed };
}
