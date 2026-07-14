import { ipcMain, session } from 'electron';

interface ApiFetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export const registerNetworkHandlers = (): void => {
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);
  });

  ipcMain.handle('api:fetch', async (_event, options: ApiFetchOptions) => {
    const doFetch = async (headers: Record<string, string>) => {
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers,
        body: options.body,
      });

      const contentType = response.headers.get('content-type') || '';
      let data: string | object;

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    };

    try {
      return await doFetch(options.headers);
    } catch (error) {
      console.error(
        `[api:fetch] ${options.method} ${options.url} -> ERROR:`,
        error instanceof Error ? error.message : error,
      );
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        headers: {},
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });
};
