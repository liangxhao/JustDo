import { BrowserWindow, ipcMain } from 'electron';

import {
  type ExtensionChangedEvent,
  type ExtensionDeleteRequest,
  type ExtensionImportRequest,
  ExtensionIpc,
  type ExtensionSetEnabledRequest,
  type ExtensionUpdateConfigurationRequest,
} from '../../../shared/plugins/extensions';
import { getExtensionManagement } from '../../../shared/plugins/management';
import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import {
  PluginOperationAction,
  type PluginOperationContext,
  PluginOperationStage,
  toPluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import type { OpenClawExtensionImportService } from '../../plugins/extensions';
import { type PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';
import {
  createPluginOperationReporter,
  type PluginOperationReporter,
  withPluginOperationFailure,
} from './pluginOperationProgress';

type ExtensionHandlerDependencies = {
  extensionImportService: OpenClawExtensionImportService;
  installationService: PluginInstallationService;
  onMarketplacePluginDeleted?: (kind: typeof PluginKind.EXTENSION, runtimeId: string) => void;
  beforeAgentTeamDisable?: () => Promise<() => void>;
};

const legacyImportStages = new Set<string>([
  PluginOperationStage.PREPARING,
  PluginOperationStage.EXTRACTING,
  PluginOperationStage.VALIDATING,
  PluginOperationStage.PREPARING_RUNTIME,
  PluginOperationStage.INSTALLING,
  PluginOperationStage.INSTALLING_DEPENDENCIES,
  PluginOperationStage.RESTARTING_GATEWAY,
  'completed',
]);

export const registerExtensionHandlers = ({
  extensionImportService,
  installationService,
  onMarketplacePluginDeleted,
  beforeAgentTeamDisable,
}: ExtensionHandlerDependencies): void => {
  // Mutations can persist before reporting a restart error. Publish observed state,
  // including installs/removals, and keep catalog notifications in completion order.
  let stateNotification = Promise.resolve();
  let agentTeamMutation = Promise.resolve();
  const withAgentTeamMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = agentTeamMutation.then(operation);
    agentTeamMutation = pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    return pending;
  };
  const publishExtensionState = (extensionId: string): Promise<boolean> => {
    const notification = stateNotification.then(async () => {
      try {
        const extensions = await extensionImportService.listCatalog();
        const change: ExtensionChangedEvent = {
          extensionId,
          enabled: extensions.find(extension => extension.id === extensionId)?.enabled ?? false,
        };
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send(ExtensionIpc.Changed, change);
          }
        }
        return true;
      } catch (error) {
        console.warn(
          '[Extensions] Failed to refresh extension state after mutation:',
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    });
    stateNotification = notification.then((): void => undefined);
    return notification;
  };

  installationService.registerInstaller({
    kind: PluginKind.EXTENSION,
    install: async request => {
      if (request.payload.kind !== PluginKind.EXTENSION) {
        return { success: false, error: 'Invalid extension installation payload' };
      }
      const result = await extensionImportService.importPath(
        request.payload.sourcePath,
        request.onProgress,
        request.payload.reviewToken,
        {
          trustMarketplaceSource: request.origin === PluginInstallOrigin.MARKETPLACE,
          preserveActivation: request.operation === MarketplaceInstallOperation.UPDATE,
          ...(request.onProgress
            ? {
                onOperationProgress: stage => request.onProgress?.({ stage, percent: 0 }),
              }
            : {}),
        },
      );
      if (
        (result.success || result.installationCommitted) &&
        result.extensionId &&
        request.origin === PluginInstallOrigin.CUSTOM
      ) {
        // A local replacement no longer belongs to the previous marketplace installation.
        onMarketplacePluginDeleted?.(PluginKind.EXTENSION, result.extensionId);
      }
      let refreshWarning = false;
      if (result.extensionId) {
        request.onProgress?.({ stage: PluginOperationStage.REFRESHING_INVENTORY, percent: 0 });
        refreshWarning = !(await publishExtensionState(result.extensionId));
      }
      let installPath: string | undefined = result.installPath;
      if ((result.success || result.installationCommitted) && result.extensionId) {
        try {
          installPath ??= extensionImportService
            .listInstalled()
            .find(extension => extension.id === result.extensionId)?.installPath;
        } catch {
          console.warn('[Extensions] Installation committed, but its path could not be resolved');
        }
      }
      return {
        success: result.success,
        ...(result.installationCommitted ? { installationCommitted: true as const } : {}),
        ...(result.installSourceInUse ? { installSourceInUse: true as const } : {}),
        pluginId: result.extensionId,
        installPath,
        failedStage: result.operationFailedStage ?? result.failedStage,
        error: result.error,
        capabilityReview: result.capabilityReview,
        ...(refreshWarning ? { refreshWarning: true as const } : {}),
      };
    },
  });

  ipcMain.handle(ExtensionIpc.List, async () => {
    try {
      const extensions = await extensionImportService.listCatalog();
      return {
        success: true,
        extensions: extensions.map(extension => ({
          ...extension,
          ...getExtensionManagement({
            ...extension,
            configurationFieldCount: extension.configurationFields.length,
          }),
        })),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to list extensions';
      console.error('[Extensions] extensions:list error:', errorMsg);
      return { success: false, extensions: [], error: errorMsg };
    }
  });

  ipcMain.handle(
    ExtensionIpc.Import,
    async (event, request: ExtensionImportRequest, context?: PluginOperationContext) => {
      let progress: PluginOperationReporter | undefined;
      try {
        if (
          !request ||
          typeof request.requestId !== 'string' ||
          !request.requestId.trim() ||
          typeof request.sourcePath !== 'string' ||
          !request.sourcePath.trim() ||
          (request.reviewToken !== undefined &&
            (typeof request.reviewToken !== 'string' ||
              !request.reviewToken.trim() ||
              request.reviewToken.length > 256))
        ) {
          return { success: false, error: 'Extension source path is required' };
        }
        progress = createPluginOperationReporter(
          event,
          context ?? { requestId: request.requestId },
          PluginKind.EXTENSION,
          PluginOperationAction.INSTALL,
        );
        progress.report(PluginOperationStage.QUEUED);
        const operationProgress = progress;
        const result = await installationService.install({
          operation: MarketplaceInstallOperation.INSTALL,
          origin: PluginInstallOrigin.CUSTOM,
          payload: {
            kind: PluginKind.EXTENSION,
            sourcePath: request.sourcePath,
            ...(typeof request.reviewToken === 'string' && request.reviewToken.trim()
              ? { reviewToken: request.reviewToken.trim() }
              : {}),
          },
          onProgress: progress => {
            const stage = toPluginOperationStage(progress.stage);
            if (stage) operationProgress?.report(stage);
            if (legacyImportStages.has(progress.stage) && !event.sender.isDestroyed()) {
              try {
                event.sender.send(ExtensionIpc.ImportProgress, {
                  requestId: request.requestId,
                  sourcePath: request.sourcePath,
                  ...progress,
                });
              } catch {
                // A closing observer cannot turn a committed installation into a failure.
              }
            }
          },
        });
        return withPluginOperationFailure(progress, {
          success: result.success,
          extensionId: result.pluginId,
          failedStage: result.failedStage,
          error: result.error,
          capabilityReview: result.capabilityReview,
          ...(result.installationCommitted ? { installationCommitted: true as const } : {}),
          ...(result.installSourceInUse ? { installSourceInUse: true as const } : {}),
          ...(result.refreshWarning ? { refreshWarning: true as const } : {}),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to import extension';
        console.error('[Extensions] extensions:import error:', errorMsg);
        return withPluginOperationFailure(progress, { success: false, error: errorMsg });
      } finally {
        progress?.finish();
      }
    },
  );

  ipcMain.handle(
    ExtensionIpc.Delete,
    async (event, request: ExtensionDeleteRequest, context?: PluginOperationContext) => {
      let progress: PluginOperationReporter | undefined;
      try {
        progress = createPluginOperationReporter(
          event,
          context,
          PluginKind.EXTENSION,
          PluginOperationAction.REMOVE,
        );
        progress.report(PluginOperationStage.QUEUED);
        if (!request || typeof request.extensionId !== 'string' || !request.extensionId.trim()) {
          return progress.result({ success: false, error: 'Extension id is required' });
        }
        const extensionId = request.extensionId.trim();
        let result;
        let refreshWarning = false;
        try {
          result = await extensionImportService.delete(extensionId, progress.report);
          progress.result(result);
        } catch (error) {
          progress.captureFailure();
          throw error;
        } finally {
          progress.report(PluginOperationStage.REFRESHING_INVENTORY);
          refreshWarning = !(await publishExtensionState(extensionId));
        }
        if (result.success) onMarketplacePluginDeleted?.(PluginKind.EXTENSION, extensionId);
        return progress.result({
          ...result,
          ...(refreshWarning ? { refreshWarning: true as const } : {}),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to delete extension';
        console.error('[Extensions] extensions:delete error:', errorMsg);
        return withPluginOperationFailure(progress, { success: false, error: errorMsg });
      } finally {
        progress?.finish();
      }
    },
  );

  ipcMain.handle(
    ExtensionIpc.SetEnabled,
    async (event, request: ExtensionSetEnabledRequest, context?: PluginOperationContext) => {
      let progress: PluginOperationReporter | undefined;
      try {
        progress = createPluginOperationReporter(
          event,
          context,
          PluginKind.EXTENSION,
          request?.enabled ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
        );
        progress.report(PluginOperationStage.QUEUED);
        if (
          !request ||
          typeof request.extensionId !== 'string' ||
          !request.extensionId.trim() ||
          typeof request.enabled !== 'boolean'
        ) {
          return progress.result({
            success: false,
            error: 'Extension id and enabled state are required',
          });
        }
        const extensionId = request.extensionId.trim();
        const mutate = async () => {
          let releaseDisable: (() => void) | undefined;
          let result;
          let refreshWarning = false;
          try {
            if (extensionId === OpenClawExtensionId.AGENT_TEAM && !request.enabled) {
              if (!beforeAgentTeamDisable) throw new Error('teamDiscussionUnavailable');
              releaseDisable = await beforeAgentTeamDisable();
            }
            result = await extensionImportService.setEnabled(
              extensionId,
              request.enabled,
              typeof request.reviewToken === 'string'
                ? request.reviewToken.trim() || undefined
                : undefined,
              progress?.report,
            );
            withPluginOperationFailure(progress, result);
          } catch (error) {
            progress?.captureFailure();
            throw error;
          } finally {
            releaseDisable?.();
            progress?.report(PluginOperationStage.REFRESHING_INVENTORY);
            refreshWarning = !(await publishExtensionState(extensionId));
          }
          return withPluginOperationFailure(progress, {
            ...result,
            ...(refreshWarning ? { refreshWarning: true as const } : {}),
          });
        };
        return await (extensionId === OpenClawExtensionId.AGENT_TEAM
          ? withAgentTeamMutation(mutate)
          : mutate());
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Failed to update extension status';
        console.error('[Extensions] extensions:set-enabled error:', errorMsg);
        return withPluginOperationFailure(progress, { success: false, error: errorMsg });
      } finally {
        progress?.finish();
      }
    },
  );

  ipcMain.handle(
    ExtensionIpc.UpdateConfiguration,
    async (
      event,
      request: ExtensionUpdateConfigurationRequest,
      context?: PluginOperationContext,
    ) => {
      let progress: PluginOperationReporter | undefined;
      try {
        progress = createPluginOperationReporter(
          event,
          context,
          PluginKind.EXTENSION,
          PluginOperationAction.SAVE,
        );
        progress.report(PluginOperationStage.QUEUED);
        const valuesAreValid =
          request?.values !== null &&
          typeof request?.values === 'object' &&
          !Array.isArray(request.values) &&
          Object.keys(request.values).length <= 32 &&
          Object.entries(request.values).every(
            ([fieldPath, value]) =>
              fieldPath.length > 0 &&
              fieldPath.length <= 256 &&
              typeof value === 'string' &&
              value.length <= 16_384,
          );
        if (
          typeof request?.extensionId !== 'string' ||
          !request.extensionId.trim() ||
          !valuesAreValid
        ) {
          return progress.result({
            success: false,
            error: 'Invalid extension configuration request',
          });
        }
        return progress.result(
          await extensionImportService.updateConfiguration(
            request.extensionId.trim(),
            request.values,
            progress.report,
          ),
        );
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Failed to update extension configuration';
        console.error('[Extensions] extensions:update-configuration error:', errorMsg);
        return withPluginOperationFailure(progress, { success: false, error: errorMsg });
      } finally {
        progress?.finish();
      }
    },
  );
};
