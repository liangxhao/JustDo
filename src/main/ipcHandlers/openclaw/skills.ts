import { ipcMain } from 'electron';

import { MarketplaceSourceId, PluginKind } from '../../../shared/pluginMarketplace';
import type { GatewaySkillEntry } from '../../libs/agentEngine/types';
import type { OpenClawSkillFiles } from '../../libs/openclaw/skills/openclawSkillFiles';
import type { OpenClawSkillService } from '../../libs/openclaw/skills/openclawSkillService';
import type { PluginManager } from '../../libs/plugin';

interface SkillHandlerDependencies {
  skillService: OpenClawSkillService;
  getSkillFiles: () => OpenClawSkillFiles;
  pluginManager: PluginManager;
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

export const registerSkillHandlers = ({
  skillService,
  getSkillFiles,
  pluginManager,
}: SkillHandlerDependencies): void => {
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

  ipcMain.handle(
    'skills:install',
    async (_event, params: { id?: string; version?: string; force?: boolean } | undefined) => {
      try {
        const pluginId = params?.id?.trim();
        if (!pluginId) {
          return { success: false, error: 'Unsupported marketplace install request' };
        }
        await pluginManager.installFromMarketplace({
          sourceId: MarketplaceSourceId.DEFAULT,
          pluginId,
          kind: PluginKind.SKILL,
          version: params.version,
          force: params.force,
        });
        return { success: true };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to install skill';
        return {
          success: false,
          error: errorMsg,
          gatewayOffline: errorMsg.includes('not connected'),
        };
      }
    },
  );

  ipcMain.handle('skills:search', async (_event, options: { query?: string; limit?: number }) => {
    try {
      const results = await pluginManager.searchMarketplace({
        kind: PluginKind.SKILL,
        ...options,
      });
      return {
        success: true,
        results: results.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          author: skill.author,
          tags: skill.tags,
          homepage: skill.homepage,
        })),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to search skills';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:detail', async (_event, options: { id?: string } | undefined) => {
    try {
      const pluginId = options?.id?.trim();
      if (!pluginId) {
        return { success: false, error: 'Marketplace plugin id is required' };
      }
      const detail = await pluginManager.getMarketplaceDetail({
        sourceId: MarketplaceSourceId.DEFAULT,
        pluginId,
        kind: PluginKind.SKILL,
      });
      return {
        success: true,
        detail: detail
          ? {
              id: detail.id,
              name: detail.name,
              description: detail.description,
              version: detail.version,
              author: detail.author,
              tags: detail.tags,
              homepage: detail.homepage,
              readme: detail.readme,
              install: detail.requirements ? { requires: detail.requirements } : undefined,
            }
          : null,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to get skill detail';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:import', async (_event, archivePath: string) => {
    try {
      return getSkillFiles().importArchive(archivePath);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import skill';
      console.error('[Skills] skills:import error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('skills:importFolder', async (_event, folderPath: string) => {
    try {
      return getSkillFiles().importDirectory(folderPath);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Failed to import skill from folder';
      console.error('[Skills] skills:importFolder error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      getSkillFiles().delete(id);
      const status = await skillService.getStatus();
      return { success: true, skills: status.skills.map(mapGatewaySkill) };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to delete skill';
      return { success: false, error: errorMsg };
    }
  });
};
