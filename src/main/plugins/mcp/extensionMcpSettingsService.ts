import {
  allowedPluginAction,
  blockedPluginAction,
  getExtensionProvidedManagement,
  PluginActionReason,
} from '../../../shared/plugins/management';
import type {
  ExtensionMcpMutationError,
  ExtensionMcpMutationResult,
  ExtensionMcpSettingsResult,
  ExtensionProvidedMcpServer,
} from '../../../shared/plugins/mcp';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const withExtensionMcpManagement = (
  server: ExtensionProvidedMcpServer,
  userNames: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
): ExtensionProvidedMcpServer => {
  const base = getExtensionProvidedManagement({
    id: server.providerId,
    name: server.providerName,
    scope: server.scope,
  });
  const toggle = protectedIds.has(server.providerId)
    ? blockedPluginAction(PluginActionReason.MANAGED_BY_SYSTEM)
    : server.toggleable === true && server.supported && !userNames.has(server.name)
      ? allowedPluginAction()
      : base.management.enable;
  return {
    ...server,
    ...base,
    management: { ...base.management, enable: toggle, disable: toggle },
  };
};

type Dependencies = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  listServers: () => Promise<ExtensionProvidedMcpServer[]>;
  readDefinition: (id: string) => Promise<Record<string, unknown> | null>;
};

const nativeErrorCode = (
  error: unknown,
  fallback: ExtensionMcpMutationError,
): ExtensionMcpMutationError => {
  const message = error instanceof Error ? error.message : '';
  if (/baseHash|conflict|changed since/i.test(message)) return 'conflict';
  if (/forbidden|unauthorized|permission|scope/i.test(message)) return 'forbidden';
  if (/invalid|validation|schema|unrecognized/i.test(message)) return 'invalid';
  if (/disconnect|not connected|not running|unavailable|timeout|ENGINE_NOT_READY/i.test(message))
    return 'unavailable';
  return fallback;
};

/** Gateway configuration remains the sole authority, including scoped connection overrides. */
export class ExtensionMcpSettingsService {
  constructor(private readonly deps: Dependencies) {}

  private async snapshot() {
    const snapshot = await this.deps.request<{
      valid?: boolean;
      config?: unknown;
      sourceConfig?: unknown;
      hash?: string;
    }>('config.get', {});
    if (
      snapshot.valid !== true ||
      !isRecord(snapshot.config) ||
      typeof snapshot.hash !== 'string' ||
      !snapshot.hash
    ) {
      throw new Error('Native MCP configuration unavailable');
    }
    const config = isRecord(snapshot.sourceConfig) ? snapshot.sourceConfig : snapshot.config;
    const mcp = isRecord(config.mcp) ? config.mcp : {};
    const configured = isRecord(mcp.servers) ? mcp.servers : {};
    return { configured, revision: snapshot.hash };
  }

  async readSettings(id: unknown): Promise<ExtensionMcpSettingsResult> {
    if (typeof id !== 'string' || !id.trim()) return { success: false, code: 'invalid' };
    try {
      const snapshot = await this.snapshot();
      const server = (await this.deps.listServers()).find(entry => entry.id === id);
      if (!server) return { success: false, code: 'forbidden' };
      const override = Object.hasOwn(snapshot.configured, server.name)
        ? snapshot.configured[server.name]
        : null;
      const hasConnection = isRecord(override) && ('command' in override || 'url' in override);
      const definition = hasConnection ? override : await this.deps.readDefinition(server.id);
      return {
        success: true,
        value: {
          server,
          revision: snapshot.revision,
          definition: definition
            ? { ...definition, ...(!hasConnection && isRecord(override) ? override : {}) }
            : null,
          override: isRecord(override) ? override : null,
        },
      };
    } catch (error) {
      return { success: false, code: nativeErrorCode(error, 'unknown') };
    }
  }

  async setEnabled(
    input: unknown,
    syncConfig: () => Promise<{ error?: string }>,
    onProgress?: (stage: PluginOperationStage) => void,
  ): Promise<ExtensionMcpMutationResult> {
    if (
      !isRecord(input) ||
      typeof input.id !== 'string' ||
      !input.id.trim() ||
      typeof input.enabled !== 'boolean' ||
      Object.keys(input).some(key => key !== 'id' && key !== 'enabled')
    ) {
      return { success: false, code: 'invalid' };
    }
    let failure: ExtensionMcpMutationError = 'unknown';
    try {
      onProgress?.(PluginOperationStage.VALIDATING);
      const snapshot = await this.snapshot();
      const servers = await this.deps.listServers();
      const server = servers.find(entry => entry.id === input.id);
      const capability = input.enabled ? server?.management?.enable : server?.management?.disable;
      if (!server || !capability?.allowed || server.name === '__proto__') {
        return { success: false, code: 'forbidden' };
      }
      const configured = snapshot.configured;
      const current = Object.hasOwn(configured, server.name) ? configured[server.name] : undefined;
      if (current !== undefined && !isRecord(current)) {
        return { success: false, code: 'conflict' };
      }
      if (server.enabled !== input.enabled) {
        onProgress?.(PluginOperationStage.SAVING_CONFIGURATION);
        await this.deps.request('config.patch', {
          baseHash: snapshot.revision,
          raw: JSON.stringify({
            mcp: {
              servers: {
                [server.name]: input.enabled
                  ? isRecord(current) && Object.keys(current).some(key => key !== 'enabled')
                    ? { enabled: true }
                    : null
                  : { enabled: false },
              },
            },
          }),
        });
      }
      // Use the existing application/reload confirmation, including global config serialization.
      // An uncertain native write is never replayed or compensated by an inverse write.
      failure = 'apply-failed';
      onProgress?.(PluginOperationStage.APPLYING_CONFIGURATION);
      const applied = await syncConfig();
      if (applied.error) return { success: false, code: failure };
      onProgress?.(PluginOperationStage.CONFIRMING);
      const confirmed = await this.deps.listServers();
      if (confirmed.find(entry => entry.id === input.id)?.enabled !== input.enabled) {
        return { success: false, code: failure };
      }
      return { success: true, extensionServers: confirmed };
    } catch (error) {
      return { success: false, code: nativeErrorCode(error, failure) };
    }
  }
}
