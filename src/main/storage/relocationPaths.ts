import fs from 'node:fs';
import path from 'node:path';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function relocateOpenClawPath(value: string, sourceRoot: string, targetRoot: string): string {
  if (!path.isAbsolute(value)) return value;
  const source = path.toNamespacedPath(path.join(sourceRoot, 'openclaw'));
  const project = (absolute: string) => {
    const relative = path.relative(source, path.toNamespacedPath(absolute));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
      return undefined;
    return path.join(targetRoot, 'openclaw', relative);
  };
  const direct = project(value);
  if (direct) return direct;
  try { return project(fs.realpathSync.native(value)) ?? value; }
  catch { return value; }
}

/** Project configured paths into the moved OpenClaw tree. Session content remains opaque. */
export function prepareRelocatedOpenClawConfig(
  config: Record<string, unknown>,
  sourceRoot: string,
  targetRoot: string,
): Record<string, unknown> {
  const next = structuredClone(config);
  const project = (value: unknown) =>
    typeof value === 'string' ? relocateOpenClawPath(value, sourceRoot, targetRoot) : value;
  const fields = (owner: unknown, ...keys: string[]) => {
    if (!record(owner)) return;
    for (const key of keys) {
      if (typeof owner[key] === 'string') owner[key] = project(owner[key]);
    }
  };
  const list = (owner: unknown, key: string) => {
    if (record(owner) && Array.isArray(owner[key])) owner[key] = owner[key].map(project);
  };
  const workspace = (owner: unknown) => {
    if (!record(owner)) return;
    fields(owner, 'cwd', 'workspace', 'agentDir');
    fields(owner.sandbox, 'workspaceRoot');
  };

  fields(next, 'worktreeRoot');
  fields(next.session, 'store');
  if (record(next.agents)) {
    workspace(next.agents.defaults);
    if (record(next.agents.entries)) Object.values(next.agents.entries).forEach(workspace);
  }
  if (record(next.skills)) list(next.skills.load, 'extraDirs');
  if (record(next.plugins)) {
    list(next.plugins.load, 'paths');
    if (record(next.plugins.installs)) {
      for (const install of Object.values(next.plugins.installs))
        fields(install, 'installPath', 'sourcePath');
    }
  }
  if (record(next.secrets) && record(next.secrets.providers)) {
    for (const provider of Object.values(next.secrets.providers)) {
      if (!record(provider)) continue;
      if (provider.source === 'file') fields(provider, 'path');
      if (provider.source === 'exec') {
        fields(provider, 'command');
        list(provider, 'args');
      }
    }
  }
  return next;
}
