import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

type PermissionMode = 'ask' | 'auto' | 'full';

type PluginConfig = {
  mode: PermissionMode;
};

// These are the core file-mutation tool ids covered by this policy.
const FILE_MUTATION_TOOLS = new Set(['apply_patch', 'edit', 'write']);

const parsePluginConfig = (value: unknown): PluginConfig => {
  let mode: PermissionMode = 'ask';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const config = value as Record<string, unknown>;
    if (config.mode === 'auto' || config.mode === 'full') mode = config.mode;
  }
  return { mode };
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

const plugin = {
  id: 'file-permission-policy',
  name: 'File Permission Policy',
  description: 'Requires approval before file-changing tools run in ask mode.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    const effectiveMode: 'ask' | 'full' = config.mode === 'full' ? 'full' : 'ask';
    api.registerTrustedToolPolicy({
      id: 'core-file-mutation',
      description: 'Policy for OpenClaw core file mutations.',
      evaluate: async event => {
        if (effectiveMode === 'full' || !FILE_MUTATION_TOOLS.has(event.toolName)) {
          return;
        }

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
      'filePermissionPolicy.info',
      async ({ respond }) => {
        respond(true, {
          loaded: true,
          adapterVersion: 1,
          configuredMode: config.mode,
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
