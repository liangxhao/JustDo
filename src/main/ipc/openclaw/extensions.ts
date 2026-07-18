import { ipcMain } from 'electron';

import {
  type ExtensionDeleteRequest,
  type ExtensionImportRequest,
  ExtensionIpc,
  type ExtensionSetEnabledRequest,
  type ExtensionUpdateConfigurationRequest,
} from '../../../shared/openclaw/extensions';
import type { OpenClawExtensionImportService } from '../../plugins/extensions';

type ExtensionHandlerDependencies = {
  extensionImportService: OpenClawExtensionImportService;
};

export const registerExtensionHandlers = ({
  extensionImportService,
}: ExtensionHandlerDependencies): void => {
  ipcMain.handle(ExtensionIpc.List, () => {
    try {
      return { success: true, extensions: extensionImportService.listInstalled() };
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
        !request.sourcePath.trim()
      ) {
        return { success: false, error: 'Extension source path is required' };
      }
      return await extensionImportService.importPath(request.sourcePath, progress => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(ExtensionIpc.ImportProgress, { ...request, ...progress });
        }
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to import extension';
      console.error('[Extensions] extensions:import error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(ExtensionIpc.Delete, async (_event, request: ExtensionDeleteRequest) => {
    try {
      if (
        !request ||
        typeof request.extensionId !== 'string' ||
        !request.extensionId.trim()
      ) {
        return { success: false, error: 'Extension id is required' };
      }
      return await extensionImportService.delete(request.extensionId.trim());
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to delete extension';
      console.error('[Extensions] extensions:delete error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle(
    ExtensionIpc.SetEnabled,
    async (_event, request: ExtensionSetEnabledRequest) => {
      try {
        if (
          !request ||
          typeof request.extensionId !== 'string' ||
          !request.extensionId.trim() ||
          typeof request.enabled !== 'boolean'
        ) {
          return { success: false, error: 'Extension id and enabled state are required' };
        }
        return await extensionImportService.setEnabled(
          request.extensionId.trim(),
          request.enabled,
        );
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Failed to update extension status';
        console.error('[Extensions] extensions:set-enabled error:', errorMsg);
        return { success: false, error: errorMsg };
      }
    },
  );

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
