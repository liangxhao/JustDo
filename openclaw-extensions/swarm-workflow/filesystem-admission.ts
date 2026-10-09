import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export function permissionFingerprint(
  value: unknown,
  agentIds: readonly string[] = ['main'],
): string {
  const config = record(value);
  const agents = record(config.agents);
  const defaults = record(agents.defaults);
  const entries = Object.fromEntries(
    agentIds.map(key => {
      const item = record(agents.entries)[key];
      const agent = record(item);
      return [key, { tools: agent.tools, sandbox: agent.sandbox, workspace: agent.workspace }];
    }),
  );
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          tools: config.tools,
          agents: {
            defaults: { sandbox: defaults.sandbox, workspace: defaults.workspace },
            entries,
          },
        }),
      ),
    )
    .digest('hex');
}
export const inside = (base: string, target: string): boolean => {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};
export type FilesystemAdmission = {
  workspaceOnly: boolean;
  root: string;
  policy: string;
  dev: string;
  ino: string;
  agentIds: string[];
};
export function assertFilesystemAdmission(admission: FilesystemAdmission): void {
  const canonicalRoot = realpathSync.native(admission.root);
  const identity = statSync(admission.root, { bigint: true });
  if (
    !identity.isDirectory() ||
    path.relative(admission.root, canonicalRoot) !== '' ||
    identity.dev.toString() !== admission.dev ||
    identity.ino.toString() !== admission.ino
  )
    throw new Error(
      'Native project filesystem identity changed. Re-admit the flow from its parent conversation.',
    );
}
/** Only native tool context may supply the effective policy. RPC input cannot. */
export function captureFilesystemAdmission(
  context: {
    fsPolicy?: { workspaceOnly: boolean; root?: string };
    agentId?: string;
    workspaceDir?: string;
    sandboxed?: boolean;
    config?: unknown;
    runtimeConfig?: unknown;
    getRuntimeConfig?: () => unknown;
  },
  cwd: string,
  permissionMode: string,
  currentConfig: unknown,
): FilesystemAdmission {
  if (
    !context.fsPolicy ||
    typeof context.fsPolicy.workspaceOnly !== 'boolean' ||
    context.sandboxed ||
    permissionMode === 'read-only'
  )
    throw new Error('Batch input snapshots require a writable native host filesystem admission.');
  const project = realpathSync.native(cwd);
  const workspace = context.workspaceDir && realpathSync.native(context.workspaceDir);
  if (!workspace || path.relative(project, workspace) !== '')
    throw new Error('Native project context does not match the parent.');
  const root = context.fsPolicy.workspaceOnly
    ? context.fsPolicy.root && realpathSync.native(context.fsPolicy.root)
    : project;
  if (!root || !inside(root, project))
    throw new Error('Project is outside the effective native filesystem root.');
  // Native fsPolicy is prepared from ctx.config, not the fresher runtimeConfig.
  const admittedConfig = context.config;
  if (!admittedConfig)
    throw new Error('Native filesystem permission configuration is unavailable.');
  const agentIds = [context.agentId ?? 'main'];
  const policy = permissionFingerprint(admittedConfig, agentIds);
  if (
    permissionFingerprint(currentConfig, agentIds) !== policy ||
    (context.runtimeConfig && permissionFingerprint(context.runtimeConfig, agentIds) !== policy) ||
    (context.getRuntimeConfig &&
      permissionFingerprint(context.getRuntimeConfig(), agentIds) !== policy)
  )
    throw new Error('Native filesystem admission belongs to an outdated permission configuration.');
  // Full host mode still delegates only this project, never arbitrary host reads.
  const identity = statSync(project, { bigint: true });
  return {
    workspaceOnly: context.fsPolicy.workspaceOnly,
    root: project,
    policy,
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    agentIds,
  };
}
