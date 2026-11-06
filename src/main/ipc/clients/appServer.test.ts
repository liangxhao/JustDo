import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppServerIntegrationIpc } from '../../../shared/integrations/appServerIntegration';
import type { AppServerIntegrationService } from '../../clients/appServer/appServerIntegrationService';
import { registerAppServerIntegrationHandlers } from './appServer';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  },
}));
afterEach(() => handlers.clear());

function fixture() {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: vi.fn(() => false) };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const status = {
    running: true, url: 'ws://127.0.0.1:1234/app-server', configuredPort: 0, restartRequired: false,
  };
  const config = { url: status.url, headers: { Authorization: 'Bearer private' } };
  const service = {
    getStatus: vi.fn(() => status), getConnectionConfig: vi.fn(() => config),
    setPort: vi.fn(() => status), regenerateToken: vi.fn(() => status),
  };
  const getService = vi.fn(() => service as unknown as AppServerIntegrationService);
  const getMainWindow = vi.fn((): BrowserWindow | null => window as unknown as BrowserWindow);
  const isQuitting = vi.fn(() => false);
  registerAppServerIntegrationHandlers({ getService, getMainWindow, isQuitting });
  const event = { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const read = (channel: string, input = event, ...args: unknown[]) => handlers.get(channel)!(input, ...args);
  return { contents, window, status, config, service, getService, getMainWindow, isQuitting, event, read };
}

it('exposes status and explicitly requested credentials only to the main application frame', () => {
  const f = fixture();
  expect(f.read(AppServerIntegrationIpc.GetStatus)).toEqual(f.status);
  expect(f.service.getConnectionConfig).not.toHaveBeenCalled();
  expect(f.read(AppServerIntegrationIpc.GetConnectionConfig)).toEqual(f.config);
  expect([...handlers.keys()]).toEqual(Object.values(AppServerIntegrationIpc));
  expect(f.getService).toHaveBeenCalledTimes(2);
});

it('saves a valid port and regenerates credentials only through the main frame', () => {
  const f = fixture();
  expect(f.read(AppServerIntegrationIpc.SetPort, f.event, 0)).toEqual(f.status);
  expect(f.read(AppServerIntegrationIpc.SetPort, f.event, 65535)).toEqual(f.status);
  expect(f.service.setPort.mock.calls).toEqual([[0], [65535]]);
  expect(f.read(AppServerIntegrationIpc.RegenerateToken)).toEqual(f.status);
  expect(f.service.regenerateToken).toHaveBeenCalledOnce();
  expect(f.service.getConnectionConfig).not.toHaveBeenCalled();
});

it.each([undefined, null, -1, 65536, 1.5, NaN, Infinity, '13042', { port: 13042 }, []])(
  'rejects an invalid port payload without saving', port => {
    const f = fixture();
    expect(() => f.read(AppServerIntegrationIpc.SetPort, f.event, port)).toThrow('Invalid');
    expect(f.service.setPort).not.toHaveBeenCalled();
    expect(f.service.regenerateToken).not.toHaveBeenCalled();
  },
);

describe.each(Object.values(AppServerIntegrationIpc))('%s authorization', channel => {
  it.each(['child frame', 'other renderer', 'destroyed sender', 'destroyed window', 'no window', 'quitting'])(
    'rejects %s before resolving the service',
    invalidSource => {
      const f = fixture();
      let event = f.event;
      if (invalidSource === 'child frame') {
        event = { ...event, senderFrame: {} } as IpcMainInvokeEvent;
      } else if (invalidSource === 'other renderer') {
        event = { ...event, sender: { isDestroyed: () => false } } as IpcMainInvokeEvent;
      } else if (invalidSource === 'destroyed sender') {
        f.contents.isDestroyed.mockReturnValue(true);
      } else if (invalidSource === 'destroyed window') {
        f.window.isDestroyed.mockReturnValue(true);
      } else if (invalidSource === 'no window') {
        f.getMainWindow.mockReturnValue(null);
      } else {
        f.isQuitting.mockReturnValue(true);
      }
      expect(() => f.read(channel, event)).toThrow('main application frame');
      expect(f.getService).not.toHaveBeenCalled();
      expect(f.service.getStatus).not.toHaveBeenCalled();
      expect(f.service.getConnectionConfig).not.toHaveBeenCalled();
      expect(f.service.setPort).not.toHaveBeenCalled();
      expect(f.service.regenerateToken).not.toHaveBeenCalled();
    },
  );
});
