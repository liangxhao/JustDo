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
import type { OpenClawExtensionImportService } from '../../plugins/extensions';
import { type PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';

type ExtensionHandlerDependencies = {
  extensionImportService: OpenClawExtensionImportService;
  installationService: PluginInstallationService;
  onMarketplacePluginDeleted?: (kind: typeof PluginKind.EXTENSION, runtimeId: string) => void;
};

export const registerExtensionHandlers = ({
  extensionImportService,
  installationService,
  onMarketplacePluginDeleted,
}: ExtensionHandlerDependencies): void => {
  // Mutations can persist before reporting a restart error. Publish observed state,
  // including installs/removals, and keep catalog notifications in completion order.
  let stateNotification = Promise.resolve();
  const publishExtensionState = (extensionId: string): Promise<void> => {
    stateNotification = stateNotification.then(async () => {
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
      } catch (error) {
        console.warn(
          '[Extensions] Failed to refresh extension state after mutation:',
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return stateNotification;
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
        { trustMarketplaceSource: request.origin === PluginInstallOrigin.MARKETPLACE },
      );
      if (result.extensionId) await publishExtensionState(result.extensionId);
      return {
        success: result.success,
        pluginId: result.extensionId,
        failedStage: result.failedStage,
        error: result.error,
        capabilityReview: result.capabilityReview,
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

  ipcMain.handle(ExtensionIpc.Import, async (event, request: ExtensionImportRequest) => {
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
          if (!event.sender.isDestroyed()) {
            event.sender.send(ExtensionIpc.ImportProgress, {
              requestId: request.requestId,
              sourcePath: request.sourcePath,
              ...progress,
            });
          }
        },
      });
      return {
        success: result.success,
        extensionId: result.pluginId,
        failedStage: result.failedStage,
        error: result.error,
        capabilityReview: result.capabilityReview,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import extension';
      console.error('[Extensions] extensions:import error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(ExtensionIpc.Delete, async (_event, request: ExtensionDeleteRequest) => {
    try {
      if (!request || typeof request.extensionId !== 'string' || !request.extensionId.trim()) {
        return { success: false, error: 'Extension id is required' };
      }
      const extensionId = request.extensionId.trim();
      let result;
      try {
        result = await extensionImportService.delete(extensionId);
      } finally {
        await publishExtensionState(extensionId);
      }
      if (result.success) onMarketplacePluginDeleted?.(PluginKind.EXTENSION, extensionId);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to delete extension';
      console.error('[Extensions] extensions:delete error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(ExtensionIpc.SetEnabled, async (_event, request: ExtensionSetEnabledRequest) => {
    try {
      if (
        !request ||
        typeof request.extensionId !== 'string' ||
        !request.extensionId.trim() ||
        typeof request.enabled !== 'boolean'
      ) {
        return { success: false, error: 'Extension id and enabled state are required' };
      }
      const extensionId = request.extensionId.trim();
      try {
        return await extensionImportService.setEnabled(
          extensionId,
          request.enabled,
          typeof request.reviewToken === 'string'
            ? request.reviewToken.trim() || undefined
            : undefined,
        );
      } finally {
        await publishExtensionState(extensionId);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to update extension status';
      console.error('[Extensions] extensions:set-enabled error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(
    ExtensionIpc.UpdateConfiguration,
    async (_event, request: ExtensionUpdateConfigurationRequest) => {
      try {
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
          return { success: false, error: 'Invalid extension configuration request' };
        }
        return await extensionImportService.updateConfiguration(
          request.extensionId.trim(),
          request.values,
        );
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Failed to update extension configuration';
        console.error('[Extensions] extensions:update-configuration error:', errorMsg);
        return { success: false, error: errorMsg };
      }
    },
  );
};
