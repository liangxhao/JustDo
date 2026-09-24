import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

type PluginConfig = {
  approvalTimeoutMs: number;
};

const PLUGIN_ID = 'automation-permission';
const AUTOMATION_TOOL_NAMES = new Set(['automations', 'cron']);
const MUTATION_ACTIONS = new Set(['add', 'update', 'remove', 'run', 'wake']);
const TRUSTED_POLICY_ID = 'native-session-automation-permission';
// Stay below OpenClaw's 512-code-point post-sanitization protocol limit.
const APPROVAL_DESCRIPTION_MAX_LENGTH = 400;
const APPROVAL_PARAM_STRING_MAX_LENGTH = 120;
const APPROVAL_TRUNCATION_SUFFIX = '…[truncated]';
const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 2;
const APPROVAL_TIMEOUT_MINUTES = new Set([2, 5, 10]);
const APPROVAL_INVISIBLE_CHAR_PATTERN =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/u;

const parsePluginConfig = (value: unknown): PluginConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MINUTES * 60_000,
    };
  }
  const record = value as Record<string, unknown>;
  const configuredTimeoutMinutes = record.approvalTimeoutMinutes;
  const approvalTimeoutMinutes =
    typeof configuredTimeoutMinutes === 'number' &&
    APPROVAL_TIMEOUT_MINUTES.has(configuredTimeoutMinutes)
      ? configuredTimeoutMinutes
      : DEFAULT_APPROVAL_TIMEOUT_MINUTES;
  return {
    approvalTimeoutMs: approvalTimeoutMinutes * 60_000,
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

const truncateByCodePoint = (value: string, maxLength: number): string => {
  const codePoints = [...value];
  if (codePoints.length <= maxLength) return value;
  return `${codePoints.slice(0, maxLength - [...APPROVAL_TRUNCATION_SUFFIX].length).join('')}${APPROVAL_TRUNCATION_SUFFIX}`;
};

const sanitizedDisplayCost = (char: string): number =>
  APPROVAL_INVISIBLE_CHAR_PATTERN.test(char)
    ? `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? 'FFFD'}}`.length
    : 1;

const truncateBySanitizedDisplayCost = (value: string, maxLength: number): string => {
  const codePoints = [...value];
  const totalCost = codePoints.reduce((sum, char) => sum + sanitizedDisplayCost(char), 0);
  if (totalCost <= maxLength) return value;

  const suffixCost = [...APPROVAL_TRUNCATION_SUFFIX].reduce(
    (sum, char) => sum + sanitizedDisplayCost(char),
    0,
  );
  const budget = maxLength - suffixCost;
  let used = 0;
  let end = 0;
  while (end < codePoints.length) {
    const nextCost = sanitizedDisplayCost(codePoints[end]!);
    if (used + nextCost > budget) break;
    used += nextCost;
    end += 1;
  }
  return `${codePoints.slice(0, end).join('')}${APPROVAL_TRUNCATION_SUFFIX}`;
};

const serializeApprovalParams = (action: string, params: unknown): string => {
  try {
    return (
      JSON.stringify(params, (_key, value) => {
        if (typeof value === 'string') {
          return truncateByCodePoint(value, APPROVAL_PARAM_STRING_MAX_LENGTH);
        }
        if (typeof value === 'bigint') return value.toString();
        return value;
      }) || `{ "action": "${action}" }`
    );
  } catch {
    return `{ "action": "${action}" }`;
  }
};

const describeMutation = (action: string, params: unknown): string =>
  truncateBySanitizedDisplayCost(
    `Scheduled task action: ${action}. Parameters: ${serializeApprovalParams(action, params)}`,
    APPROVAL_DESCRIPTION_MAX_LENGTH,
  );

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
    api.registerTrustedToolPolicy({
      id: TRUSTED_POLICY_ID,
      description: 'Requires approval for automation mutations outside Full sessions.',
      evaluate: async (event, context) => {
        const action = readMutationAction(event);
        if (!action) return;

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
            description: describeMutation(action, event.params),
            severity: 'warning' as const,
            timeoutMs: config.approvalTimeoutMs,
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
          approvalTimeoutMs: config.approvalTimeoutMs,
        });
      },
      { scope: 'operator.read' },
    );
    api.logger.info('[automation-permission] native session permission policy enabled.');
  },
};

export default plugin;
