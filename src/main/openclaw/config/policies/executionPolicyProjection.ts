import {
  AgentRuntimeCodeMode,
  type AgentRuntimeSettings,
  DEFAULT_AGENT_RUNTIME_SETTINGS,
} from '../../../../shared/agents/agentRuntimeSettings';
import {
  BrowserMode,
  type BrowserMode as BrowserModeValue,
} from '../../../../shared/browser/browser';
import { PermissionMode } from '../../../../shared/security/approvals';
import { WINDOWS_SANDBOX_BACKEND_ID } from '../../../../shared/security/windowsSandbox';
import type { CoworkExecutionMode } from '../../../data/coworkStore';
import { isRecord } from '../configShape';

export const buildManagedOpenClawCronConfig = (existing: unknown): Record<string, unknown> => ({
  enabled: true,
  skipMissedJobs: true,
  sessionRetention: '7d',
  ...(isRecord(existing) ? existing : {}),
});

export const OPENCLAW_MANAGED_TOOL_DENY = [
  'ask_user',
  'web_search',
  'message',
  'nodes',
  'gateway',
  'openclaw',
  'file_fetch',
  'dir_list',
  'dir_fetch',
  'file_write',
  'portal',
  'dashboard',
  'github_identity_status',
  'presence',
  'theme',
  'transcripts',
  'mobile_ui',
  'intent',
  'secrets',
  'conversations_send',
  'conversations_list',
  'conversations_turn',
] as const;

export const mapExecutionModeToSandboxMode = (mode: CoworkExecutionMode): 'off' | 'all' => {
  switch (mode) {
    case 'sandbox':
      return 'all';
    case 'local':
    default:
      return 'off';
  }
};

export const OPENCLAW_FALLBACK_EXEC_MODE = PermissionMode.Ask;

export const OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY = true;

export const buildManagedOpenClawSandboxConfig = (mode: CoworkExecutionMode) => {
  const sandboxMode = mapExecutionModeToSandboxMode(mode);
  return {
    mode: sandboxMode,
    ...(sandboxMode === 'all'
      ? {
          backend: WINDOWS_SANDBOX_BACKEND_ID,
          scope: 'session' as const,
          workspaceAccess: 'rw' as const,
        }
      : {}),
  };
};

export const resolveOpenClawExecHost = (mode: CoworkExecutionMode): 'gateway' | 'sandbox' =>
  mapExecutionModeToSandboxMode(mode) === 'all' ? 'sandbox' : 'gateway';

/** Default agent timeout used when no persisted runtime preference exists. */
export const OPENCLAW_AGENT_TIMEOUT_SECONDS =
  DEFAULT_AGENT_RUNTIME_SETTINGS.agent.runTimeoutSeconds;

// Provider idle timeout for slow long-context model calls. This remains finite
// even though the main Agent has no overall turn limit by default.
export const OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS = 30 * 60;

// Stable product defaults retained for callers and focused config tests.
export const OPENCLAW_SUBAGENT_MAX_CONCURRENT =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.maxConcurrent;

export const OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.maxChildrenPerAgent;

// Allow substantial work while still terminating runaway subagent runs.
export const OPENCLAW_SUBAGENT_RUN_TIMEOUT_SECONDS =
  DEFAULT_AGENT_RUNTIME_SETTINGS.subagents.runTimeoutSeconds;

export const OPENCLAW_MCP_TOOL_OWNER = 'bundle-mcp';

export const OPENCLAW_DECISION_EVALUATION_TOOL = 'decision_evaluate';

export const mergeManagedOptionalToolPolicy = (
  existing: unknown,
): { allow?: string[]; alsoAllow?: string[] } => {
  const policy = isRecord(existing) ? existing : {};
  const usesAllow =
    Array.isArray(policy.allow) &&
    policy.allow.some(value => typeof value === 'string' && value.trim().length > 0);
  const values = usesAllow ? policy.allow : policy.alsoAllow;
  const allowed = [
    ...new Set([
      ...(Array.isArray(values)
        ? values.filter((value): value is string => typeof value === 'string')
        : []),
      OPENCLAW_DECISION_EVALUATION_TOOL,
    ]),
  ];
  // Native OpenClaw rejects allow + alsoAllow in the same policy scope.
  // An empty native allowlist is unrestricted; do not turn it into Jev-only access.
  return usesAllow
    ? { allow: allowed, alsoAllow: undefined }
    : { allow: undefined, alsoAllow: allowed };
};

export const OPENCLAW_COLLABORATION_TOOLS = [
  'task_assistants',
  'assistants_create',
  'team_discussion',
] as const;

export const buildManagedOpenClawSandboxToolConfig = (mode: CoworkExecutionMode) => ({
  tools: {
    alsoAllow: [
      ...OPENCLAW_COLLABORATION_TOOLS,
      OPENCLAW_DECISION_EVALUATION_TOOL,
      ...(mapExecutionModeToSandboxMode(mode) === 'all' ? [] : [OPENCLAW_MCP_TOOL_OWNER]),
    ],
  },
});

export const buildManagedOpenClawExecutionToolConfig = (
  mode: CoworkExecutionMode,
  sourceTools: unknown,
) => {
  const tools = isRecord(sourceTools) ? sourceTools : {};
  return {
    fs: {
      ...(isRecord(tools.fs) ? tools.fs : {}),
      workspaceOnly: OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
    },
    exec: {
      ...(isRecord(tools.exec) ? tools.exec : {}),
      host: resolveOpenClawExecHost(mode),
      mode: OPENCLAW_FALLBACK_EXEC_MODE,
    },
    sandbox: buildManagedOpenClawSandboxToolConfig(mode),
  };
};

export const OPENCLAW_MAX_SKILLS_IN_PROMPT = 200;

export const OPENCLAW_MAX_SKILLS_PROMPT_CHARS = 50_000;

export const mergeManagedOpenClawCodeModeConfig = (
  existing: unknown,
  settings: AgentRuntimeSettings = DEFAULT_AGENT_RUNTIME_SETTINGS,
): Record<string, unknown> => ({
  ...(isRecord(existing) ? existing : {}),
  enabled:
    settings.codeMode.mode === AgentRuntimeCodeMode.Auto
      ? 'auto'
      : settings.codeMode.mode === AgentRuntimeCodeMode.On,
  // Model-authored programs run in the native isolated executor. Permissions
  // and approvals remain on the Gateway tool bridge.
  executor: 'quickjs',
});

export const mergeManagedOpenClawSwarmConfig = (
  existing: unknown,
  settings: AgentRuntimeSettings = DEFAULT_AGENT_RUNTIME_SETTINGS,
): Record<string, unknown> => ({
  ...(isRecord(existing) ? existing : {}),
  ...settings.swarm,
});

export const buildManagedOpenClawConnectivityConfig = (
  browserMode: BrowserModeValue = BrowserMode.Embedded,
  sessionVisibility: AgentRuntimeSettings['sessions']['visibility'] = DEFAULT_AGENT_RUNTIME_SETTINGS
    .sessions.visibility,
) => ({
  update: {
    checkOnStart: false,
    auto: {
      enabled: false,
    },
  },
  transcripts: { enabled: false },
  tools: {
    updatePlan: true,
    // Optional evaluation is admitted only when its default-off plugin is enabled.
    ...mergeManagedOptionalToolPolicy(undefined),
    // OpenClaw v2026.9.6 owns native tool-directory discovery and hydration.
    toolSearch: {
      enabled: true,
      mode: 'directory',
    },
    sessions: {
      visibility: sessionVisibility,
    },
    deny: [...OPENCLAW_MANAGED_TOOL_DENY],
    web: {
      search: {
        enabled: false,
      },
      fetch: {
        enabled: true,
        // JustDo already passes its operator-controlled outbound proxy to the
        // Gateway. Let that proxy resolve hostnames so Fake-IP DNS does not
        // fail OpenClaw's pre-connect address checks.
        useTrustedEnvProxy: true,
        ssrfPolicy: {
          // Clash/Surge-style fake-IP DNS maps public hostnames into the
          // RFC 2544 benchmark range. OpenClaw blocks that range by default,
          // so opt into its narrow compatibility exception without allowing
          // private, loopback, link-local, or arbitrary reserved addresses.
          allowRfc2544BenchmarkRange: true,
        },
      },
    },
  },
  browser: {
    // Provider ownership lives in plugins.entries. Toggling this root switch
    // would require a Gateway restart under the native browser reload policy.
    enabled: true,
    // The bundled v2.2.0 extension uses Browser Relay Authentication v2.
    // Fail closed instead of retaining OpenClaw's one-release legacy window.
    extensionRelay: {
      allowLegacyAuth: false,
    },
    defaultProfile:
      browserMode === BrowserMode.User
        ? 'user'
        : browserMode === BrowserMode.Extension
          ? 'chrome'
          : 'openclaw',
    ...(browserMode === BrowserMode.User
      ? {
          profiles: {
            user: {
              driver: 'existing-session',
              attachOnly: true,
              ...(process.platform === 'win32' ? { mcpCommand: 'chrome-mcp.cmd' } : {}),
            },
          },
        }
      : browserMode === BrowserMode.Extension
        ? {
            profiles: {
              chrome: {
                driver: 'extension',
              },
            },
          }
        : {}),
    // Local execution can already reach the user's network through command
    // tools. Keep browser behavior consistent and allow proxy Fake-IP ranges
    // plus user-authorized LAN destinations without requiring hidden setup.
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true,
    },
  },
});
