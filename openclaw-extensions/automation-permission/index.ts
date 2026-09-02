import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

type PluginConfig = {
  unrestrictedAgentIds: ReadonlySet<string>;
};

const PLUGIN_ID = 'automation-permission';
const AUTOMATION_TOOL_NAMES = new Set(['automations', 'cron']);
const MUTATION_ACTIONS = new Set(['add', 'update', 'remove', 'run', 'wake']);
const TRUSTED_POLICY_ID = 'native-session-automation-permission';
const APPROVAL_TIMEOUT_ENV = 'JUSTDO_EXEC_APPROVAL_TIMEOUT_MS';
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

const readApprovalTimeoutMs = (): number => {
  const configured = process.env[APPROVAL_TIMEOUT_ENV];
  if (configured === '0') return Number.MAX_SAFE_INTEGER;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_TIMER_TIMEOUT_MS)
    : DEFAULT_APPROVAL_TIMEOUT_MS;
};

const parsePluginConfig = (value: unknown): PluginConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { unrestrictedAgentIds: new Set() };
  }
  const configuredAgentIds = (value as Record<string, unknown>).unrestrictedAgentIds;
  return {
    unrestrictedAgentIds: new Set(
      Array.isArray(configuredAgentIds)
        ? configuredAgentIds.filter(
            (agentId): agentId is string =>
              typeof agentId === 'string' && agentId.trim().length > 0,
          )
        : [],
    ),
  };
};

const readMutationAction = (event: { toolName: string; params?: unknown }): string | null => {
  if (
    !AUTOMATION_TOOL_NAMES.has(event.toolName) ||
    !event.params ||
    typeof event.params !== 'object' ||
    Array.isArray(event.params)
  )
    return null;
  const action = (event.params as Record<string, unknown>).action;
  return typeof action === 'string' && MUTATION_ACTIONS.has(action) ? action : null;
};

const describeMutation = (action: string): string =>
  `Scheduled task action: ${action}. Open the desktop app to review full details.`;

const detailMutation = (action: string, params: unknown): string =>
  JSON.stringify(params, null, 2) || `{ "action": "${action}" }`;

const isUnrestrictedAutomationRun = (
  agentId: string | undefined,
  sessionKey: string | undefined,
  unrestrictedAgentIds: ReadonlySet<string>,
): boolean => {
  if (!agentId || !unrestrictedAgentIds.has(agentId) || !sessionKey) return false;
  const prefix = `agent:${agentId}:cron:`;
  if (!sessionKey.startsWith(prefix)) return false;
  const [jobId, runSegment, runId] = sessionKey.slice(prefix.length).split(':');
  return Boolean(jobId && runSegment === 'run' && runId);
};

const plugin = {
  id: PLUGIN_ID,
  name: 'Automation Permission',
  description: 'Applies the native session permission mode to automation mutations.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const approvalTimeoutMs = readApprovalTimeoutMs();
    api.registerTrustedToolPolicy({
      id: TRUSTED_POLICY_ID,
      description: 'Requires approval for automation mutations outside Full sessions.',
      evaluate: async (event, context) => {
        const action = readMutationAction(event);
        if (!action) return;
        if (
          isUnrestrictedAutomationRun(
            context.agentId,
            context.sessionKey,
            config.unrestrictedAgentIds,
          )
        )
          return;

        const sessionEntry = context.sessionKey
          ? api.runtime.agent.session.getSessionEntry({
              sessionKey: context.sessionKey,
              ...(context.agentId ? { agentId: context.agentId } : {}),
              readConsistency: 'latest',
            })
          : undefined;
        if (sessionEntry?.permissionMode === 'full') return;
        if (sessionEntry?.permissionMode === 'read-only') {
          return {
            allow: false,
            reason: 'Automation mutations are disabled in read-only sessions.',
          };
        }

        return {
          requireApproval: {
            pluginId: PLUGIN_ID,
            title: 'Allow scheduled task change?',
            description: describeMutation(action),
            detail: detailMutation(action, event.params),
            severity: 'warning' as const,
            timeoutMs: approvalTimeoutMs,
            timeoutBehavior: 'deny' as const,
            allowedDecisions: ['allow-once', 'deny'] as const,
          },
        };
      },
    });
    api.registerGatewayMethod(
      'automationPermission.info',
      async ({ respond }) => {
        respond(true, {
          loaded: true,
          policyId: TRUSTED_POLICY_ID,
          approvalTimeoutMs,
          unrestrictedAgentIds: [...config.unrestrictedAgentIds].sort(),
        });
      },
      { scope: 'operator.read' },
    );
    api.logger.info('[automation-permission] native session permission policy enabled.');
  },
};

export default plugin;
