import { exec } from 'child_process';
import { ipcMain } from 'electron';
import { promisify } from 'util';

const execAsync = promisify(exec);

const checkCalendarPermission = async (): Promise<string> => {
  if (process.platform === 'darwin') {
    try {
      await execAsync('osascript -l JavaScript -e \'Application("Calendar").name()\'', {
        timeout: 5_000,
      });
      return 'authorized';
    } catch (error) {
      const stderr =
        typeof error === 'object' && error && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      if (
        stderr.includes('不能获取对象') ||
        stderr.includes('not authorized') ||
        stderr.includes('Permission denied')
      ) {
        return 'not-determined';
      }
      console.warn('[Permissions] Failed to check macOS calendar permission:', error);
      return 'not-determined';
    }
  }
  if (process.platform === 'win32') {
    try {
      const script =
        'try { $Outlook = New-Object -ComObject Outlook.Application; $Outlook.Version } catch { exit 1 }';
      await execAsync(`powershell -Command "${script}"`, { timeout: 10_000 });
      return 'authorized';
    } catch {
      return 'not-determined';
    }
  }
  return 'not-supported';
};

const requestCalendarPermission = async (): Promise<boolean> => {
  if (process.platform === 'darwin') {
    try {
      await execAsync(
        'osascript -l JavaScript -e \'Application("Calendar").calendars()[0].name()\'',
        { timeout: 10_000 },
      );
      return true;
    } catch (error) {
      console.warn('[Permissions] Failed to request macOS calendar permission:', error);
      return false;
    }
  }
  return process.platform === 'win32' ? (await checkCalendarPermission()) === 'authorized' : false;
};

export const registerCalendarPermissionHandlers = (isDev: boolean): void => {
  ipcMain.handle('permissions:checkCalendar', async () => {
    try {
      let status = await checkCalendarPermission();
      if (isDev && status === 'not-determined' && process.platform === 'darwin') {
        await requestCalendarPermission();
        status = await checkCalendarPermission();
        return { success: true, status, autoRequested: true };
      }
      return { success: true, status };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check permission',
      };
    }
  });

  ipcMain.handle('permissions:requestCalendar', async () => {
    try {
      const granted = await requestCalendarPermission();
      return { success: true, granted, status: await checkCalendarPermission() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to request permission',
      };
    }
  });
};
