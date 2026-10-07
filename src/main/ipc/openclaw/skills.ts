import { ipcMain } from 'electron';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { getSkillManagementCapabilities, getSkillScope } from '../../../shared/plugins/skillManagement';
import { isUserOwnedSkillSource } from '../../../shared/plugins/skills';
import type { GatewaySkillEntry } from '../../engine/types';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';
import type {
  OpenClawSkillFileService,
  OpenClawSkillService,
} from '../../plugins/skills';
import { resolveSkillOwnershipScope } from '../../plugins/skills/openclawSkillOwnership';

interface SkillHandlerDependencies {
  skillService: OpenClawSkillService;
  skillFileService: Pick<OpenClawSkillFileService, 'importPath' | 'deleteDirectory'> &
    Partial<Pick<OpenClawSkillFileService, 'getManagedSkillPath'>>;
  installationService: PluginInstallationService;
  getOpenClawEngineManager?: () => OpenClawEngineManager;
  onMarketplacePluginDeleted?: (
    kind: typeof PluginKind.SKILL,
    runtimeId: string,
    installPath: string,
  ) => void;
}

const mapGatewaySkill = (entry: GatewaySkillEntry, manager?: OpenClawEngineManager) => ({
  id: entry.skillKey,
  name: entry.name,
  description: entry.description,
  // Skills can require an explicit opt-in even when Gateway does not mark them disabled.
  enabled:
    !entry.disabled &&
    !entry.missing.config.includes(`skills.entries.${entry.skillKey}.enabled`),
  isOfficial: entry.bundled,
  isBuiltIn: entry.bundled,
  updatedAt: 0,
  prompt: '',
  skillPath: entry.filePath,
  version: undefined as string | undefined,
  source: entry.source,
  eligible: entry.eligible,
  missing: entry.missing,
  install: entry.install,
  emoji: entry.emoji,
  homepage: entry.homepage,
  scope: getSkillScope(entry.source, entry.filePath),
  ownershipScope: resolveSkillOwnershipScope(entry, manager),
  management: getSkillManagementCapabilities({
    source: entry.source,
    bundled: entry.bundled,
    eligible: entry.eligible,
    hasPath: Boolean(entry.filePath),
    filePath: entry.filePath,
  }),
});

export const registerSkillHandlers = ({
  skillService,
  skillFileService,
  installationService,
  getOpenClawEngineManager,
  onMarketplacePluginDeleted,
}: SkillHandlerDependencies): void => {
  const mapSkill = (entry: GatewaySkillEntry) =>
    mapGatewaySkill(entry, getOpenClawEngineManager?.());
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: async request => {
      if (request.payload.kind !== PluginKind.SKILL) {
        return { success: false, error: 'Invalid skill installation payload' };
      }
      const result = await skillFileService.importPath(request.payload.sourcePath);
      return {
        success: result.success,
        pluginId: result.skillId,
        installPath: result.skillId
          ? skillFileService.getManagedSkillPath?.(result.skillId)
          : undefined,
        error: result.error,
      };
    },
  });

  ipcMain.handle('skills:list', async () => {
    try {
      const status = await skillService.getStatus();
      return {
        success: true,
        skills: status.skills.map(mapSkill),
        workspaceDir: status.workspaceDir,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to load skills';
      console.error('[Skills] skills:list error:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      if (typeof options?.id !== 'string' || !options.id.trim() || typeof options.enabled !== 'boolean') {
        return { success: false, error: 'Skill id and enabled state are required' };
      }
      const currentStatus = await skillService.getStatus();
      const currentSkill = currentStatus.skills.find(entry => entry.skillKey === options.id.trim());
      if (!currentSkill) return { success: false, error: 'Skill not found' };
      const capabilities = getSkillManagementCapabilities({
        source: currentSkill.source,
        bundled: currentSkill.bundled,
        eligible: currentSkill.eligible,
        hasPath: Boolean(currentSkill.filePath),
        filePath: currentSkill.filePath,
      });
      const requestedAction = options.enabled ? capabilities.enable : capabilities.disable;
      if (!requestedAction.allowed) {
        return { success: false, error: requestedAction.reason || 'Skill status cannot be changed' };
      }
      const result = await skillService.updateConfig({
        skillKey: options.id.trim(),
        enabled: options.enabled,
      });
      if (!result.ok) {
        return { success: false, error: result.error || 'Failed to update skill' };
      }
      const status = await skillService.getStatus();
      return { success: true, skills: status.skills.map(mapSkill) };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to update skill';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:import', async (_event, sourcePath: string) => {
    try {
      const result = await installationService.install({
        operation: MarketplaceInstallOperation.INSTALL,
        origin: PluginInstallOrigin.CUSTOM,
        payload: { kind: PluginKind.SKILL, sourcePath },
      });
      return { success: result.success, skillId: result.pluginId, error: result.error };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import skill';
      console.error('[Skills] skills:import error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('skills:delete', async (_event, request: { id?: unknown; source?: unknown }) => {
    try {
      const skillId = typeof request?.id === 'string' ? request.id.trim() : '';
      const requestedSource = request?.source;
      if (!skillId || !isUserOwnedSkillSource(requestedSource)) {
        return { success: false, error: 'Skill id and source are required' };
      }

      const currentStatus = await skillService.getStatus();
      const skill = currentStatus.skills.find(
        entry => entry.skillKey === skillId && entry.source === requestedSource,
      );
      if (!skill || skill.bundled || !isUserOwnedSkillSource(skill.source)) {
        return { success: false, error: 'Only user-owned skills can be deleted' };
      }

      await skillFileService.deleteDirectory(skill.baseDir);
      onMarketplacePluginDeleted?.(PluginKind.SKILL, skillId, skill.baseDir);
      const updatedStatus = await skillService.getStatus();
      return { success: true, skills: updatedStatus.skills.map(mapSkill) };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to delete skill';
      return { success: false, error: errorMsg };
    }
  });
};
