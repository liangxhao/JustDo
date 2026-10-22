import fs from 'fs';

import { OpenClawProviderId } from '../../../shared/providers';
import { isRecord, sortJsonValue } from './configShape';
import {
  BUILTIN_MODEL_SECRET_PROVIDER_ID,
  BUILTIN_MODELS_API_KEY_PLACEHOLDER,
  containsBuiltinMemorySearchRef,
  containsBuiltinModelRef,
} from './models/builtinSecretProjection';

export type OpenClawConfigVerification = {
  ok: boolean;
  error?: string;
};

export const verifyLoggedOutOpenClawConfig = (configPath: string): OpenClawConfigVerification => {
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read synced OpenClaw config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (
    content.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER) ||
    content.includes(BUILTIN_MODEL_SECRET_PROVIDER_ID)
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: built-in authentication placeholder remains.`,
    };
  }

  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isRecord(config)) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: root must be an object.`,
    };
  }

  const models = isRecord(config.models) ? config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  if (Object.prototype.hasOwnProperty.call(providers, OpenClawProviderId.BuiltinModels)) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: built-in provider remains.`,
    };
  }

  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const memory = isRecord(config.memory) ? config.memory : {};
  const defaultMemorySearch = isRecord(memory.search) ? memory.search : {};
  if (
    containsBuiltinModelRef(defaults.model) ||
    containsBuiltinMemorySearchRef(defaultMemorySearch)
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: default built-in model reference remains.`,
    };
  }

  if (
    isRecord(agents.entries) &&
    Object.values(agents.entries).some(
      agent => isRecord(agent) && containsBuiltinModelRef(agent.model),
    )
  ) {
    return {
      ok: false,
      error: `OpenClaw logout config verification failed at ${configPath}: agent built-in model reference remains.`,
    };
  }

  return { ok: true };
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
  requiresGatewayRestart: boolean;
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
  secretsChanged?: boolean;
  modelDefaultsOnly?: boolean;
};

export const buildVerifiedConfigSyncResult = (
  configPath: string,
  expectedConfig: Record<string, unknown>,
  changed: boolean,
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
  return {
    ok: true,
    changed,
    configChanged: changed,
    requiresGatewayRestart: false,
    configPath,
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
