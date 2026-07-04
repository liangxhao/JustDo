import { ipcMain, session } from 'electron';

interface ApiFetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ApiStreamOptions extends ApiFetchOptions {
  requestId: string;
}

// 存储活跃的流式请求控制器
const activeStreamControllers = new Map<string, AbortController>();

export const registerApiProxyHandlers = (): void => {
  // API 代理处理程序 - 解决 CORS 问题
  ipcMain.handle('api:fetch', async (_event, options: ApiFetchOptions) => {
    console.log(
      `[api:fetch] ${options.method} ${options.url}, headers: ${JSON.stringify(options.headers)}, body: ${options.body}`,
    );

    const doFetch = async (headers: Record<string, string>) => {
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers,
        body: options.body,
      });

      const contentType = response.headers.get('content-type') || '';
      let data: string | object;

      if (contentType.includes('text/event-stream')) {
        data = await response.text();
      } else if (contentType.includes('application/json')) {
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
      const result = await doFetch(options.headers);
      console.log(
        `[api:fetch] ${options.method} ${options.url} -> ${result.status} ${result.statusText}`,
        typeof result.data === 'object' ? JSON.stringify(result.data) : result.data,
      );

      return result;
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

  // SSE 流式 API 代理
  ipcMain.handle('api:stream', async (event, options: ApiStreamOptions) => {
    const controller = new AbortController();

    // 存储 controller 以便后续取消
    activeStreamControllers.set(options.requestId, controller);

    try {
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.text();
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        };
      }

      if (!response.body) {
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: 'No response body',
        };
      }

      // 读取流式响应并通过 IPC 发送
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const readStream = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              event.sender.send(`api:stream:${options.requestId}:done`);
              break;
            }
            const chunk = decoder.decode(value);
            event.sender.send(`api:stream:${options.requestId}:data`, chunk);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            event.sender.send(`api:stream:${options.requestId}:abort`);
          } else {
            event.sender.send(
              `api:stream:${options.requestId}:error`,
              error instanceof Error ? error.message : 'Stream error',
            );
          }
        } finally {
          activeStreamControllers.delete(options.requestId);
        }
      };

      // 异步读取流，立即返回成功状态
      void readStream();

      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      activeStreamControllers.delete(options.requestId);
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // 取消流式请求
  ipcMain.handle('api:stream:cancel', (_event, requestId: string) => {
    const controller = activeStreamControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(requestId);
      return true;
    }
    return false;
  });
};
