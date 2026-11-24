import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { isRecord, sortJsonValue } from './configShape';

export type OpenClawConfigVerification = {
  ok: boolean;
  error?: string;
};

export const hasOpenClawConfigChanged = (
  currentContent: string,
  nextConfig: Record<string, unknown>,
): boolean => {
  try {
    const currentConfig = JSON.parse(currentContent) as unknown;
    if (!isRecord(currentConfig)) {
      return true;
    }
    return (
      JSON.stringify(sortJsonValue(currentConfig)) !== JSON.stringify(sortJsonValue(nextConfig))
    );
  } catch {
    return true;
  }
};

export const verifyOpenClawConfigMatches = (
  configPath: string,
  expectedConfig: Record<string, unknown>,
): OpenClawConfigVerification => {
  let actualContent: string;
  try {
    actualContent = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read back OpenClaw config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (hasOpenClawConfigChanged(actualContent, expectedConfig)) {
    return {
      ok: false,
      error: `OpenClaw config read-back verification failed at ${configPath}: persisted content does not match the requested config.`,
    };
  }

  return { ok: true };
};

export type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configChanged: boolean;
  configMissing?: true;
  requiresGatewayRestart: boolean;
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
  secretsChanged?: boolean;
  modelDefaultsOnly?: boolean;
  publication?: OpenClawConfigPublication;
};

export type OpenClawConfigPublication = {
  path: string;
  isCurrent: () => boolean;
};

export const buildVerifiedConfigSyncResult = (
  configPath: string,
  expectedConfig: Record<string, unknown>,
  changed: boolean,
  trackPublication = false,
): OpenClawConfigSyncResult => {
  const verification = verifyOpenClawConfigMatches(configPath, expectedConfig);
  if (!verification.ok) {
    return {
      ok: false,
      changed: false,
      configChanged: false,
      requiresGatewayRestart: false,
      configPath,
      error: verification.error,
    };
  }
  const hash = (content: string) => createHash('sha256').update(content).digest('hex');
  const publishedHash = changed && trackPublication
    ? hash(`${JSON.stringify(expectedConfig, null, 2)}\n`)
    : null;
  return {
    ok: true,
    changed,
    configChanged: changed,
    requiresGatewayRestart: false,
    configPath,
    ...(publishedHash && {
      publication: {
        path: configPath,
        isCurrent: () => {
          try {
            return hash(fs.readFileSync(configPath, 'utf8')) === publishedHash;
          } catch {
            return false;
          }
        },
      },
    }),
  };
};

export const buildMissingEmbeddedBrowserResult = (
  configPath: string,
): OpenClawConfigSyncResult => ({
  ok: false,
  changed: false,
  configChanged: false,
  requiresGatewayRestart: false,
  configPath,
  error: 'The bundled embedded browser provider is unavailable.',
});
