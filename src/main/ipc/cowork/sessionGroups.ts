import { ipcMain } from 'electron';

import type { GroupStore } from '../../data/groupStore';

export const registerSessionGroupHandlers = (getStore: () => GroupStore): void => {
  ipcMain.handle('sessionGroup:list', async () => {
    try {
      return { success: true, groups: getStore().listGroups() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list groups',
      };
    }
  });

  ipcMain.handle('sessionGroup:create', async (_event, input: { name: string; color?: string }) => {
    try {
      return { success: true, group: getStore().createGroup(input) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create group',
      };
    }
  });

  ipcMain.handle(
    'sessionGroup:update',
    async (_event, id: string, input: { name?: string; color?: string; sortOrder?: number }) => {
      try {
        return { success: true, group: getStore().updateGroup(id, input) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update group',
        };
      }
    },
  );

  ipcMain.handle('sessionGroup:delete', async (_event, id: string) => {
    try {
      return { success: getStore().deleteGroup(id) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete group',
      };
    }
  });

  ipcMain.handle(
    'sessionGroup:moveSession',
    async (_event, sessionId: string, groupId: string | null) => {
      try {
        return { success: getStore().moveSessionToGroup(sessionId, groupId) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to move session',
        };
      }
    },
  );

  ipcMain.handle('sessionGroup:reorder', async (_event, groupIds: string[]) => {
    try {
      getStore().reorderGroups(groupIds);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reorder groups',
      };
    }
  });
};
