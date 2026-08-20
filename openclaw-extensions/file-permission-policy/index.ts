import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { randomUUID } from 'node:crypto';

type PermissionMode = 'ask' | 'auto' | 'full';

type PluginConfig = {
  mode: PermissionMode;
  fullAgentIds: ReadonlySet<string>;
};

// These are the core file-mutation tool ids covered by this policy.
const FILE_MUTATION_TOOLS = new Set(['apply_patch', 'edit', 'write']);
const CRON_MUTATION_ACTIONS = new Set(['add', 'update', 'remove', 'run']);
const MAX_CRON_APPROVAL_DETAILS = 128;
const MAX_CRON_APPROVAL_DETAIL_CHARS = 64 * 1024;

const parsePluginConfig = (value: unknown): PluginConfig => {
  let mode: PermissionMode = 'ask';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const config = value as Record<string, unknown>;
    if (config.mode === 'auto' || config.mode === 'full') mode = config.mode;
    const fullAgentIds = Array.isArray(config.fullAgentIds)
      ? config.fullAgentIds.filter(
          (agentId): agentId is string => typeof agentId === 'string' && agentId.trim().length > 0,
        )
      : [];
    return { mode, fullAgentIds: new Set(fullAgentIds) };
  }
  return { mode, fullAgentIds: new Set() };
};

const readTargetPaths = (event: { derivedPaths?: unknown; params?: unknown }): string[] => {
  const paths: string[] = [];
  if (Array.isArray(event.derivedPaths)) {
    for (const value of event.derivedPaths) {
      if (typeof value === 'string' && value.trim()) paths.push(value.trim());
    }
  }
  if (event.params && typeof event.params === 'object' && !Array.isArray(event.params)) {
    const params = event.params as Record<string, unknown>;
    for (const key of ['path', 'filePath', 'file_path', 'notebookPath', 'notebook_path']) {
      const value = params[key];
      if (typeof value === 'string' && value.trim()) paths.push(value.trim());
    }
  }
  return [...new Set(paths)].slice(0, 3);
};

const readCronMutationAction = (event: { toolName: string; params?: unknown }): string | null => {
  if (event.toolName !== 'cron' || !event.params || typeof event.params !== 'object') return null;
  const action = (event.params as Record<string, unknown>).action;
  return typeof action === 'string' && CRON_MUTATION_ACTIONS.has(action) ? action : null;
};

const describeCronMutationSummary = (params: unknown, detailNonce?: string): string => {
  const prefix = `justdo-detail:${detailNonce ?? 'unavailable'}\n`;
  const serialized = JSON.stringify(params);
  const available = 240 - prefix.length;
  if (!serialized || serialized.length <= available) return `${prefix}${serialized || '{}'}`;
  const suffix = '... [open in JustDo for full details]';
  return `${prefix}${Array.from(serialized).slice(0, available - suffix.length).join('')}${suffix}`;
};

const normalizeIdentity = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const plugin = {
  id: 'file-permission-policy',
  name: 'File Permission Policy',
  description: 'Requires approval before file and scheduled-task mutations in restricted modes.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const effectiveMode: 'ask' | 'full' = config.mode === 'full' ? 'full' : 'ask';
    const cronApprovalDetails = new Map<
      string,
      {
        description: string;
        toolCallId: string;
        agentId?: string;
        sessionKey?: string;
      }
    >();
    api.registerTrustedToolPolicy({
      id: 'core-file-mutation',
      description: 'Policy for OpenClaw file and scheduled-task mutations.',
      evaluate: async (event, ctx) => {
        if (
          effectiveMode === 'full' ||
          (ctx?.agentId !== undefined && config.fullAgentIds.has(ctx.agentId))
        ) {
          return;
        }

        const cronAction = readCronMutationAction(event);
        if (cronAction) {
          const toolCallId = normalizeIdentity(event.toolCallId ?? ctx?.toolCallId);
          const description = JSON.stringify(event.params, null, 2);
          const detailNonce =
            toolCallId && description.length <= MAX_CRON_APPROVAL_DETAIL_CHARS
              ? randomUUID()
              : undefined;
          if (toolCallId && detailNonce) {
            while (cronApprovalDetails.size >= MAX_CRON_APPROVAL_DETAILS) {
              const oldestNonce = cronApprovalDetails.keys().next().value;
              if (typeof oldestNonce !== 'string') break;
              cronApprovalDetails.delete(oldestNonce);
            }
            cronApprovalDetails.set(detailNonce, {
              description,
              toolCallId,
              agentId: normalizeIdentity(ctx?.agentId),
              sessionKey: normalizeIdentity(ctx?.sessionKey),
            });
          }
          return {
            requireApproval: {
              pluginId: 'file-permission-policy',
              title: 'Allow scheduled task change?',
              description: describeCronMutationSummary(event.params, detailNonce),
              severity: 'warning' as const,
              timeoutMs: 10 * 60 * 1000,
              timeoutBehavior: 'deny' as const,
              allowedDecisions: ['allow-once', 'deny'] as const,
            },
          };
        }

        if (!FILE_MUTATION_TOOLS.has(event.toolName)) return;

        const paths = readTargetPaths(event);
        return {
          requireApproval: {
            pluginId: 'file-permission-policy',
            title: 'Allow file changes?',
            description: paths.length > 0 ? paths.join(', ').slice(0, 256) : event.toolName,
            severity: 'warning' as const,
            timeoutMs: 10 * 60 * 1000,
            timeoutBehavior: 'deny' as const,
            allowedDecisions: ['allow-once', 'deny'] as const,
          },
        };
      },
    });
    api.registerGatewayMethod(
      'filePermissionPolicy.approvalDetails',
      async ({ params, respond }) => {
        const toolCallId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as Record<string, unknown>).toolCallId
            : undefined;
        const nonce =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as Record<string, unknown>).nonce
            : undefined;
        const agentId =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as Record<string, unknown>).agentId
            : undefined;
        const sessionKey =
          params && typeof params === 'object' && !Array.isArray(params)
            ? (params as Record<string, unknown>).sessionKey
            : undefined;
        const detail = typeof nonce === 'string' ? cronApprovalDetails.get(nonce) : null;
        const matches =
          detail &&
          detail.toolCallId === normalizeIdentity(toolCallId) &&
          detail.agentId === normalizeIdentity(agentId) &&
          detail.sessionKey === normalizeIdentity(sessionKey);
        respond(
          true,
          matches ? { found: true, description: detail.description } : { found: false },
        );
      },
      { scope: 'operator.read' },
    );
    api.registerGatewayMethod(
      'filePermissionPolicy.info',
      async ({ respond }) => {
        respond(true, {
          loaded: true,
          adapterVersion: 2,
          configuredMode: config.mode,
          fullAgentIds: [...config.fullAgentIds].sort(),
        });
      },
      { scope: 'operator.read' },
    );
    api.logger.info(
      `[file-permission-policy] policy enabled (${config.mode} -> ${effectiveMode}).`,
    );
  },
};

export default plugin;
