import { ipcMain } from 'electron';

import type { OpenClawRuntimeAdapter } from '../../libs/agentEngine';
import type { GatewaySkillEntry, SkillInstallParams } from '../../libs/agentEngine/types';
import type { OpenClawSkillFiles } from '../../libs/openclaw/skills/openclawSkillFiles';
import { createSkillMarketplaceService } from '../../libs/skillMarketplace';

type SkillMarketplaceService = ReturnType<typeof createSkillMarketplaceService>;

interface SkillHandlerDependencies {
  getRuntimeAdapter: () => OpenClawRuntimeAdapter | null;
  getSkillFiles: () => OpenClawSkillFiles;
  marketplaceService: SkillMarketplaceService;
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
  getRuntimeAdapter,
  getSkillFiles,
  marketplaceService,
}: SkillHandlerDependencies): void => {
  ipcMain.handle('skills:list', async () => {
    try {
      const adapter = getRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'Gateway not connected', gatewayOffline: true };
      }
      const status = await adapter.getSkillsStatus();
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
      const adapter = getRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'Gateway not connected', gatewayOffline: true };
      }
      const result = await adapter.updateSkillConfig({
        skillKey: options.id,
        enabled: options.enabled,
      });
      if (!result.ok) {
        return { success: false, error: result.error || 'Failed to update skill' };
      }
      const status = await adapter.getSkillsStatus();
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

  ipcMain.handle('skills:install', async (_event, params: SkillInstallParams) => {
    try {
      if (!('source' in params) || params.source !== 'clawhub') {
        return { success: false, error: 'Unsupported marketplace install request' };
      }
      return await marketplaceService.install(params);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to install skill';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:search', async (_event, options: { query?: string; limit?: number }) => {
    try {
      return { success: true, results: await marketplaceService.search(options) };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to search skills';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:detail', async (_event, options: { slug: string }) => {
    try {
      return { success: true, detail: await marketplaceService.getDetail(options.slug) };
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
      const adapter = getRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'Gateway not connected', gatewayOffline: true };
      }
      const status = await adapter.getSkillsStatus();
      return { success: true, skills: status.skills.map(mapGatewaySkill) };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to delete skill';
      return { success: false, error: errorMsg };
    }
  });
};
