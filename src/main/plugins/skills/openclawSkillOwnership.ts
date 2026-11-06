import fs from 'fs';
import path from 'path';

import { PluginHubScope, type PluginHubScope as PluginHubScopeValue } from '../../../shared/plugins/management';
import type { GatewaySkillEntry } from '../../engine/types';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { getSkillScope } from './skillManagement';

const isPathWithinDirectory = (rootDirectory: string, candidatePath: string): boolean => {
  const relativePath = path.relative(path.resolve(rootDirectory), path.resolve(candidatePath));
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
};

/**
 * Resolves display ownership independently from the skill's management scope.
 * Plugin-published skills are managed by their parent extension, but belong in
 * the system group only when that parent comes from OpenClaw's bundled runtime.
 */
export const resolveSkillOwnershipScope = (
  entry: GatewaySkillEntry,
  manager?: Pick<OpenClawEngineManager, 'getRuntimeRoot'>,
): PluginHubScopeValue => {
  const managementScope = getSkillScope(entry.source, entry.filePath);
  if (managementScope !== PluginHubScope.EXTENSION) return managementScope;

  const runtimeRoot = manager?.getRuntimeRoot();
  if (!runtimeRoot) return PluginHubScope.PERSONAL;

  try {
    const realSkillPath = fs.realpathSync(entry.baseDir);
    const bundledExtensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
    const realBundledExtensionsRoot = fs.realpathSync(bundledExtensionsRoot);
    return isPathWithinDirectory(realBundledExtensionsRoot, realSkillPath)
      ? PluginHubScope.SYSTEM
      : PluginHubScope.PERSONAL;
  } catch {
    // A generated link can disappear while the Gateway inventory is refreshing.
    // Unknown plugin locations are safer to present as user-owned than system-owned.
    return PluginHubScope.PERSONAL;
  }
};
