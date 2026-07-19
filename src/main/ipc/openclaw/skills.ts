import { ipcMain } from 'electron';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import type { GatewaySkillEntry } from '../../engine/types';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';
import type { OpenClawSkillFiles, OpenClawSkillService } from '../../plugins/skills';

interface SkillHandlerDependencies {
  skillService: OpenClawSkillService;
  getSkillFiles: () => OpenClawSkillFiles;
  installationService: PluginInstallationService;
}

const mapGatewaySkill = (entry: GatewaySkillEntry) => ({
  id: entry.skillKey,
  name: entry.name,
  description: entry.description,
  enabled: !entry.disabled,
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
});

const DELETABLE_SKILL_SOURCES = new Set<GatewaySkillEntry['source']>([
  'workspace',
  'agents-project',
  'agents-personal',
  'managed',
]);

const normalizeRequestedSkillSource = (
  source: unknown,
): GatewaySkillEntry['source'] | undefined => {
  if (typeof source !== 'string') return undefined;
  const aliases: Record<string, GatewaySkillEntry['source']> = {
    workspace: 'workspace',
    'openclaw-workspace': 'workspace',
    'agents-project': 'agents-project',
    'agents-skills-project': 'agents-project',
    'agents-personal': 'agents-personal',
    'agents-skills-personal': 'agents-personal',
    managed: 'managed',
    'openclaw-managed': 'managed',
  };
  return aliases[source];
};

export const registerSkillHandlers = ({
  skillService,
  getSkillFiles,
  installationService,
}: SkillHandlerDependencies): void => {
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: async request => {
      if (request.payload.kind !== PluginKind.SKILL) {
        return { success: false, error: 'Invalid skill installation payload' };
      }
      const result = await getSkillFiles().importPath(request.payload.sourcePath);
      return { success: result.success, pluginId: result.skillId, error: result.error };
    },
  });

  ipcMain.handle('skills:list', async () => {
    try {
      const status = await skillService.getStatus();
      return {
        success: true,
        skills: status.skills.map(mapGatewaySkill),
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
      const result = await skillService.updateConfig({
        skillKey: options.id,
        enabled: options.enabled,
      });
      if (!result.ok) {
        return { success: false, error: result.error || 'Failed to update skill' };
      }
      const status = await skillService.getStatus();
      return { success: true, skills: status.skills.map(mapGatewaySkill) };
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
      const requestedSource = normalizeRequestedSkillSource(request?.source);
      if (!skillId || !requestedSource) {
        return { success: false, error: 'Skill id and source are required' };
      }

      const currentStatus = await skillService.getStatus();
      const skill = currentStatus.skills.find(
        entry => entry.skillKey === skillId && entry.source === requestedSource,
      );
      if (!skill || skill.bundled || !DELETABLE_SKILL_SOURCES.has(skill.source)) {
        return { success: false, error: 'Only user-owned skills can be deleted' };
      }

      getSkillFiles().deleteDirectory(skill.baseDir);
      const updatedStatus = await skillService.getStatus();
      return { success: true, skills: updatedStatus.skills.map(mapGatewaySkill) };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to delete skill';
      return { success: false, error: errorMsg };
    }
  });
};
