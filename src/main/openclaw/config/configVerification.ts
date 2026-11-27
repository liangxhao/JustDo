import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { isRecord, sortJsonValue } from './configShape';

type OpenClawConfigVerification =
  | { ok: true; content: string }
  | { ok: false; error: string };

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

  return { ok: true, content: actualContent };
};

export type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configChanged: boolean;
  configMissing?: true;
  configPath: string;
  error?: string;
  secretsChanged?: boolean;
  builtinCredentialSessionId?: string;
  builtinProviderWithdrawn?: true;
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
  if (verification.ok === false) {
    return {
      ok: false,
      changed: false,
      configChanged: false,
      configPath,
      error: verification.error,
    };
  }
  const hash = (content: string) => createHash('sha256').update(content).digest('hex');
  const publishedHash = trackPublication
    ? hash(changed ? `${JSON.stringify(expectedConfig, null, 2)}\n` : verification.content)
    : null;
  return {
    ok: true,
    changed,
    configChanged: changed,
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
  configPath,
  error: 'The bundled embedded browser provider is unavailable.',
});
