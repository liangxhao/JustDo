import fs from 'fs';
import path from 'path';

import { PluginHubScope } from '../../../shared/plugins/management';
import type { GatewaySkillEntry } from '../../engine/types';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { inspectOpenClawExtensionCandidate } from '../extensions/openclawLocalExtensions';
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

const findSkillExtensionId = (realSkillPath: string): string | undefined => {
  let directory = realSkillPath;
  while (true) {
    const { ids } = inspectOpenClawExtensionCandidate(directory, { manifestOnly: true });
    if (ids.length) return ids[0];
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/**
 * Resolves display ownership independently from the skill's management scope.
 * Plugin-published skills are managed by their parent extension, but belong in
 * the system group only when that parent comes from OpenClaw's bundled runtime.
 */
export const resolveSkillOwnership = (
  entry: GatewaySkillEntry,
  manager?: Pick<OpenClawEngineManager, 'getRuntimeRoot'>,
): { scope: PluginHubScope; ownershipScope: PluginHubScope; extensionId?: string } => {
  const scope = getSkillScope(entry.source, entry.filePath);
  if (scope !== PluginHubScope.EXTENSION) return { scope, ownershipScope: scope };

  let extensionId: string | undefined;
  try {
    const realSkillPath = fs.realpathSync(entry.baseDir);
    extensionId = findSkillExtensionId(realSkillPath);
    const runtimeRoot = manager?.getRuntimeRoot();
    if (
      runtimeRoot &&
      isPathWithinDirectory(
        fs.realpathSync(path.join(runtimeRoot, 'dist', 'extensions')),
        realSkillPath,
      )
    ) {
      return { scope, ownershipScope: PluginHubScope.SYSTEM, extensionId };
    }
  } catch {
    // A generated link can disappear while the Gateway inventory is refreshing.
  }
  return { scope, ownershipScope: PluginHubScope.PERSONAL, extensionId };
};
