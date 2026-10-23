import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationContext,
  PluginOperationStage,
  toPluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
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
import {
  createPluginOperationReporter,
  type PluginOperationReporter,
  withPluginOperationFailure,
} from './pluginOperationProgress';

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
        let failedStage: PluginOperationStage = PluginOperationStage.INSTALLING;
        const report = (stage: PluginOperationStage) => {
          failedStage = stage;
          request.onProgress?.({ stage, percent: 0 });
        };
        report(PluginOperationStage.INSTALLING);
        const result = await skillFileService.importPath(request.payload.sourcePath);
        const installPath = result.skillId
          ? skillFileService.getManagedSkillPath?.(result.skillId)
          : undefined;
        let runtimeId =
          request.origin === PluginInstallOrigin.MARKETPLACE ? undefined : result.skillId;
        let refreshWarning = false;
        if (result.success) {
          if (result.skillId && installPath && request.origin === PluginInstallOrigin.CUSTOM) {
            // Invalidate only the replaced managed installation, not a same-name project layer.
            onMarketplacePluginDeleted?.(PluginKind.SKILL, result.skillId, installPath);
          }
          try {
            report(PluginOperationStage.REFRESHING_INVENTORY);
            const marketplace = request.origin === PluginInstallOrigin.MARKETPLACE;
            const activate =
              marketplace && request.operation === MarketplaceInstallOperation.INSTALL;
            if (marketplace && !installPath)
              throw new Error('Installed skill directory is unavailable.');
            const status = marketplace
              ? await skillService.waitForInstalledStatus(installPath!)
              : await skillService.getStatus(undefined, { connectedOnly: true });
            const installed = installPath
              ? status.skills.find(
                  entry =>
                    entry.source === 'openclaw-managed' &&
                    path.resolve(entry.baseDir) === path.resolve(installPath),
                )
              : undefined;
            if (marketplace) {
              if (!installed)
                throw new Error('Installed skill is unavailable in the Gateway inventory.');
              runtimeId = installed.skillKey;
            }
            if (activate) {
              if (!installed)
                throw new Error('Installed skill is unavailable in the Gateway inventory.');
              if (!isGatewaySkillEnabled(installed)) {
                report(PluginOperationStage.ENABLING);
                const update = await skillService.updateConfig({
                  skillKey: installed.skillKey,
                  enabled: true,
                });
                if (!update.ok)
                  throw new Error(update.error || 'Installed skill could not be enabled.');
                report(PluginOperationStage.CONFIRMING);
                await skillService.waitForEnabledStatus(installed.skillKey, true, {
                  source: installed.source,
                  baseDir: installed.baseDir,
                });
              }
            }
          } catch (error) {
            if (request.origin === PluginInstallOrigin.MARKETPLACE) {
              return {
                success: false,
                installationCommitted: true as const,
                pluginId: runtimeId,
                installPath,
                failedStage,
                error:
                  error instanceof Error ? error.message : 'Installed skill could not be enabled.',
              };
            }
            // The import committed; a failed inventory refresh must not relabel it.
            console.warn(
              '[Skills] Imported skill, but its status refresh failed:',
              error instanceof Error ? error.message : String(error),
            );
            refreshWarning = true;
          }
        }
        return {
          success: result.success,
          pluginId: runtimeId,
          installPath,
          error: result.error,
          ...(refreshWarning ? { refreshWarning: true as const } : {}),
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

  ipcMain.handle(
    'skills:setEnabled',
    async (event, options: { id: string; enabled: boolean }, context?: PluginOperationContext) => {
      let progress: PluginOperationReporter | undefined;
      try {
        progress = createPluginOperationReporter(
          event,
          context,
          PluginKind.SKILL,
          options?.enabled ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
        );
        progress.report(PluginOperationStage.QUEUED);
        return await runSkillMutation(async () => {
          let configurationApplied = false;
          try {
            if (
              typeof options?.id !== 'string' ||
              !options.id.trim() ||
              typeof options.enabled !== 'boolean'
            ) {
              return { success: false, error: 'Skill id and enabled state are required' };
            }
            progress?.report(PluginOperationStage.VALIDATING);
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
            progress?.report(
              options.enabled ? PluginOperationStage.ENABLING : PluginOperationStage.DISABLING,
            );
            const result = await skillService.updateConfig({
              skillKey: options.id.trim(),
              enabled: options.enabled,
            });
            if (!result.ok) {
              return { success: false, error: result.error || 'Failed to update skill' };
            }
            configurationApplied = true;
            progress?.report(PluginOperationStage.CONFIRMING);
            const status = await skillService.waitForEnabledStatus(
              options.id.trim(),
              options.enabled,
            );
            configurationApplied = false;
            return { success: true, skills: status.skills.map(mapSkill) };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to update skill';
            return {
              success: false,
              error: errorMsg,
              ...(configurationApplied ? { operationUnconfirmed: true as const } : {}),
              gatewayOffline:
                (error instanceof SkillStateConfirmationError && error.gatewayOffline) ||
                errorMsg.includes('not connected'),
            };
          }
        }).then(result => withPluginOperationFailure(progress, result));
      } catch (error) {
        return withPluginOperationFailure(progress, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update skill',
        });
      } finally {
        progress?.finish();
      }
    },
  );

  ipcMain.handle(
    'skills:import',
    async (event, sourcePath: string, context?: PluginOperationContext) => {
      let progress: PluginOperationReporter | undefined;
      try {
        progress = createPluginOperationReporter(
          event,
          context,
          PluginKind.SKILL,
          PluginOperationAction.INSTALL,
        );
        progress.report(PluginOperationStage.QUEUED);
        const result = await installationService.install({
          operation: MarketplaceInstallOperation.INSTALL,
          origin: PluginInstallOrigin.CUSTOM,
          payload: { kind: PluginKind.SKILL, sourcePath },
          onProgress: update => {
            const stage = toPluginOperationStage(update.stage);
            if (stage) progress?.report(stage);
          },
        });
        return progress.result({
          success: result.success,
          skillId: result.pluginId,
          error: result.error,
          ...(result.failedStage ? { failedStage: result.failedStage } : {}),
          ...(result.refreshWarning ? { refreshWarning: true as const } : {}),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to import skill';
        console.error('[Skills] skills:import error:', errorMsg);
        return withPluginOperationFailure(progress, { success: false, error: errorMsg });
      } finally {
        progress?.finish();
      }
    },
  );

  ipcMain.handle(
    'skills:delete',
    async (
      event,
      request: { id?: unknown; source?: unknown },
      context?: PluginOperationContext,
    ) => {
      let progress: PluginOperationReporter | undefined;
      try {
        progress = createPluginOperationReporter(
          event,
          context,
          PluginKind.SKILL,
          PluginOperationAction.REMOVE,
        );
        progress.report(PluginOperationStage.QUEUED);
        return await runSkillMutation(async () => {
          try {
            const skillId = typeof request?.id === 'string' ? request.id.trim() : '';
            const requestedSource = request?.source;
            if (!skillId || !isUserOwnedSkillSource(requestedSource)) {
              return { success: false, error: 'Skill id and source are required' };
            }

            progress?.report(PluginOperationStage.VALIDATING);
            const currentStatus = await skillService.getStatus();
            const skill = currentStatus.skills.find(
              entry => entry.skillKey === skillId && entry.source === requestedSource,
            );
            if (!skill || skill.bundled || !isUserOwnedSkillSource(skill.source)) {
              return { success: false, error: 'Only user-owned skills can be deleted' };
            }

            progress?.report(PluginOperationStage.UNINSTALLING);
            await skillFileService.deleteDirectory(skill.baseDir);
            onMarketplacePluginDeleted?.(PluginKind.SKILL, skillId, skill.baseDir);
            try {
              progress?.report(PluginOperationStage.REFRESHING_INVENTORY);
              const updatedStatus = await skillService.getStatus(undefined, {
                connectedOnly: true,
              });
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
                refreshWarning: true as const,
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
        }).then(result => withPluginOperationFailure(progress, result));
      } catch (error) {
        return withPluginOperationFailure(progress, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete skill',
        });
      } finally {
        progress?.finish();
      }
    },
  );
};
