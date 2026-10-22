import { DEFAULT_AGENT_RUNTIME_SETTINGS } from '../../../../shared/agents/agentRuntimeSettings';
import {
  EXTERNAL_AGENT_CATALOG,
  type ExternalAgentDefinition,
} from '../../../../shared/integrations/externalAgentCatalog';
import {
  createDefaultExternalAgentSettings,
  type ExternalAgentSettings,
} from '../../../../shared/integrations/externalAgents';
import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import type { OpenClawHookRecord } from '../../../plugins/hooks';
import type { McpServerRecord } from '../../../plugins/mcp';
import {
  type McpPackageRuntime,
  projectMcpPackageRunner,
  resolveWindowsMcpPackageRuntime,
} from '../../runtime/mcpPackageRunner';
import { getStringRecord, isRecord } from '../configShape';

export const buildOpenClawMcpServers = (
  servers: McpServerRecord[],
  requestTimeoutSeconds = DEFAULT_AGENT_RUNTIME_SETTINGS.mcp.requestTimeoutSeconds,
  packageRuntime?: McpPackageRuntime | null,
): Record<string, Record<string, unknown>> => {
  const runtime =
    packageRuntime === undefined &&
    servers.some(
      server =>
        server.transportType === 'stdio' &&
        /^(npm|npx)(?:\.cmd)?$/i.test(
          String(server.openClawConfig?.command ?? server.command ?? ''),
        ),
    )
      ? resolveWindowsMcpPackageRuntime()
      : (packageRuntime ?? null);
  return Object.fromEntries(
    servers.map(server => {
      const config: Record<string, unknown> = {
        ...(server.openClawConfig ?? {}),
        enabled: server.enabled,
      };
      if (server.requestTimeoutSeconds !== undefined) {
        config.requestTimeoutMs = server.requestTimeoutSeconds * 1_000;
      } else if (config.requestTimeoutMs === undefined) {
        config.requestTimeoutMs = requestTimeoutSeconds * 1_000;
      }
      if (server.transportType === 'stdio') {
        delete config.url;
        delete config.headers;
        if (config.command === undefined) config.command = server.command;
        if (config.args === undefined) config.args = server.args ?? [];
        if (config.env === undefined && server.env && Object.keys(server.env).length > 0) {
          config.env = server.env;
        }
      } else {
        delete config.command;
        delete config.args;
        delete config.env;
        if (config.url === undefined) config.url = server.url;
        config.transport = server.transportType === 'sse' ? 'sse' : 'streamable-http';
        if (
          config.headers === undefined &&
          server.headers &&
          Object.keys(server.headers).length > 0
        ) {
          config.headers = server.headers;
        }
      }
      return [
        server.name,
        server.transportType === 'stdio' ? projectMcpPackageRunner(config, runtime) : config,
      ];
    }),
  );
};

export const buildOpenClawHookConfig = (
  hooks: OpenClawHookRecord[],
): { hooks?: Record<string, unknown> } => {
  const entries = Object.fromEntries(
    hooks.map(hook => [
      hook.id,
      {
        ...hook.config,
        enabled: hook.enabled,
      },
    ]),
  );

  return Object.keys(entries).length > 0
    ? {
        hooks: {
          internal: {
            // This is the shared dispatch gate, including extension-provided
            // legacy Hooks. Individual entries control independent Hooks.
            enabled: true,
            entries,
          },
        },
      }
    : {};
};

export const OPENCLAW_ACP_BACKEND = OpenClawExtensionId.ACPX;

export const buildManagedOpenClawAcpConfig = (
  settings: ExternalAgentSettings = createDefaultExternalAgentSettings(),
) => {
  const allowedAgents = EXTERNAL_AGENT_CATALOG.filter(
    definition => settings.agents[definition.id].enabled,
  ).map(definition => definition.id);
  const enabled = allowedAgents.length > 0;
  return {
    enabled,
    dispatch: { enabled },
    backend: OPENCLAW_ACP_BACKEND,
    allowedAgents,
    ...(allowedAgents[0] ? { defaultAgent: allowedAgents[0] } : {}),
  };
};

export const buildManagedExternalAgentEntries = (
  workspaceDir: string,
  settings: ExternalAgentSettings = createDefaultExternalAgentSettings(),
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    EXTERNAL_AGENT_CATALOG.filter(definition => settings.agents[definition.id].enabled).map(
      definition => [
        definition.id,
        {
          workspace: workspaceDir,
          runtime: {
            type: 'acp',
            acp: {
              agent: definition.id,
              backend: OPENCLAW_ACP_BACKEND,
              cwd: workspaceDir,
            },
          },
        },
      ],
    ),
  );

export const ACPX_RESERVED_MCP_SERVER_NAMES = new Set(['openclaw-plugin-tools', 'openclaw-tools']);

/**
 * ACPX 0.13.x accepts stdio MCP bootstrap entries only. Project the effective
 * command fields without forwarding OpenClaw-only configuration such as cwd,
 * request timeouts, remote transports, or headers.
 */
export const buildManagedAcpxMcpServers = (
  servers: readonly McpServerRecord[],
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    servers.flatMap(server => {
      if (
        !server.enabled ||
        server.transportType !== 'stdio' ||
        ACPX_RESERVED_MCP_SERVER_NAMES.has(server.name)
      ) {
        return [];
      }
      const overrides = isRecord(server.openClawConfig) ? server.openClawConfig : {};
      const command =
        typeof overrides.command === 'string' ? overrides.command.trim() : server.command?.trim();
      if (!command) return [];
      const args = Array.isArray(overrides.args)
        ? overrides.args.filter((value): value is string => typeof value === 'string')
        : server.args;
      const env = getStringRecord(overrides.env) ?? server.env;
      return [
        [
          server.name,
          {
            command,
            ...(args && args.length > 0 ? { args: [...args] } : {}),
            ...(env && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
          },
        ],
      ];
    }),
  );

export const buildManagedAcpxPluginEntry = (
  settings: ExternalAgentSettings = createDefaultExternalAgentSettings(),
  catalog: readonly ExternalAgentDefinition[] = EXTERNAL_AGENT_CATALOG,
  mcpServers: readonly McpServerRecord[] = [],
): Record<string, unknown> => {
  const agentCommands = Object.fromEntries(
    catalog.flatMap(definition =>
      definition.adapter
        ? [
            [
              definition.id,
              {
                command: definition.adapter.command,
                args: [...(definition.adapter.args ?? [])],
              },
            ],
          ]
        : [],
    ),
  );
  const configuredMcpServers = settings.shareConfiguredMcpServers
    ? buildManagedAcpxMcpServers(mcpServers)
    : {};
  return {
    // Keep the bundled runtime available for per-agent connection tests even
    // when ACP delegation itself is disabled.
    enabled: true,
    config: {
      permissionMode:
        settings.permissionMode === 'full-access'
          ? 'approve-all'
          : settings.permissionMode === 'deny-all'
            ? 'deny-all'
            : 'approve-reads',
      nonInteractivePermissions:
        settings.permissionMode === 'read-only'
          ? settings.readOnlyViolationBehavior === 'fail-task'
            ? 'fail'
            : 'deny'
          : settings.permissionMode === 'full-access'
            ? 'fail'
            : 'deny',
      timeoutSeconds: settings.operationTimeoutSeconds,
      pluginToolsMcpBridge: settings.pluginToolsMcpBridge,
      openClawToolsMcpBridge: settings.openClawToolsMcpBridge,
      ...(Object.keys(configuredMcpServers).length > 0 ? { mcpServers: configuredMcpServers } : {}),
      startupProbe: false,
      diagnosticAgents: catalog.map(definition => definition.id),
      ...(Object.keys(agentCommands).length > 0 ? { agents: agentCommands } : {}),
    },
  };
};
