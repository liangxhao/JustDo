import { ipcMain } from 'electron';
import fs from 'fs';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import {
  getSkillManagementCapabilities,
  getSkillScope,
} from '../../../shared/plugins/skillManagement';
import { isUserOwnedSkillSource } from '../../../shared/plugins/skills';
import type { GatewaySkillEntry } from '../../engine/types';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { PluginInstallationService } from '../../plugins/installation';
import { PluginInstallOrigin } from '../../plugins/installation';
import type { OpenClawSkillFileService, OpenClawSkillService } from '../../plugins/skills';
import { resolveSkillOwnershipScope } from '../../plugins/skills/openclawSkillOwnership';
import {
  isGatewaySkillEnabled,
  SkillStateConfirmationError,
} from '../../plugins/skills/openclawSkillService';

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
  enabled: isGatewaySkillEnabled(entry),
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
  // Keep file discovery and config publication within the same mutation lane.
  // The file service's config/directory lock remains separate and is not nested.
  let skillMutation = Promise.resolve();
  const runSkillMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = skillMutation.then(operation);
    skillMutation = pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    return pending;
  };
  installationService.registerInstaller({
    kind: PluginKind.SKILL,
    install: request =>
      runSkillMutation(async () => {
        if (request.payload.kind !== PluginKind.SKILL) {
          return { success: false, error: 'Invalid skill installation payload' };
        }
        const result = await skillFileService.importPath(request.payload.sourcePath);
        const installPath = result.skillId
          ? skillFileService.getManagedSkillPath?.(result.skillId)
          : undefined;
        if (result.success) {
          if (result.skillId && installPath && request.origin === PluginInstallOrigin.CUSTOM) {
            // Invalidate only the replaced managed installation, not a same-name project layer.
            onMarketplacePluginDeleted?.(PluginKind.SKILL, result.skillId, installPath);
          }
          try {
            await skillService.getStatus(undefined, { connectedOnly: true });
          } catch (error) {
            // The import committed; a failed inventory refresh must not relabel it.
            console.warn(
              '[Skills] Imported skill, but its status refresh failed:',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return {
          success: result.success,
          pluginId: result.skillId,
          installPath,
          error: result.error,
        };
      }),
  });

  ipcMain.handle('skills:list', async () => {
    try {
      const status = await skillService.getStatus(undefined, { connectedOnly: true });
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

  ipcMain.handle('skills:setEnabled', (_event, options: { id: string; enabled: boolean }) =>
    runSkillMutation(async () => {
      try {
        if (
          typeof options?.id !== 'string' ||
          !options.id.trim() ||
          typeof options.enabled !== 'boolean'
        ) {
          return { success: false, error: 'Skill id and enabled state are required' };
        }
        const currentStatus = await skillService.getStatus();
        const currentSkill = currentStatus.skills.find(
          entry => entry.skillKey === options.id.trim(),
        );
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
          return {
            success: false,
            error: requestedAction.reason || 'Skill status cannot be changed',
          };
        }
        const result = await skillService.updateConfig({
          skillKey: options.id.trim(),
          enabled: options.enabled,
        });
        if (!result.ok) {
          return { success: false, error: result.error || 'Failed to update skill' };
        }
        const status = await skillService.waitForEnabledStatus(options.id.trim(), options.enabled);
        return { success: true, skills: status.skills.map(mapSkill) };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to update skill';
        return {
          success: false,
          error: errorMsg,
          gatewayOffline:
            (error instanceof SkillStateConfirmationError && error.gatewayOffline) ||
            errorMsg.includes('not connected'),
        };
      }
    }),
  );

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

  ipcMain.handle('skills:delete', (_event, request: { id?: unknown; source?: unknown }) =>
    runSkillMutation(async () => {
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
        try {
          const updatedStatus = await skillService.getStatus(undefined, { connectedOnly: true });
          return {
            success: true,
            skills: updatedStatus.skills
              .filter(
                entry =>
                  entry.skillKey !== skill.skillKey ||
                  entry.source !== skill.source ||
                  entry.baseDir !== skill.baseDir ||
                  fs.existsSync(skill.filePath),
              )
              .map(mapSkill),
          };
        } catch (error) {
          console.warn(
            '[Skills] Deleted skill, but its status refresh failed:',
            error instanceof Error ? error.message : String(error),
          );
          // Deletion is committed. Project only the confirmed removal from this
          // operation's native inventory; the next read discovers any fallback.
          return {
            success: true,
            skills: currentStatus.skills
              .filter(
                entry =>
                  entry.skillKey !== skill.skillKey ||
                  entry.source !== skill.source ||
                  entry.baseDir !== skill.baseDir,
              )
              .map(mapSkill),
          };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to delete skill';
        return { success: false, error: errorMsg };
      }
    }),
  );
};
