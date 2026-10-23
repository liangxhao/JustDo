import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppServerIntegrationIpc } from '../../shared/integrations/appServerIntegration';
import type { AppServerIntegrationService } from '../appServer/appServerIntegrationService';
import { registerAppServerIntegrationHandlers } from './appServer';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent) => unknown) =>
      handlers.set(name, handler),
  },
}));
afterEach(() => handlers.clear());

function fixture() {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: vi.fn(() => false) };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const status = { running: true, url: 'ws://127.0.0.1:1234/app-server' };
  const config = { url: status.url, headers: { Authorization: 'Bearer private' } };
  const service = { getStatus: vi.fn(() => status), getConnectionConfig: vi.fn(() => config) };
  const getService = vi.fn(() => service as unknown as AppServerIntegrationService);
  const getMainWindow = vi.fn((): BrowserWindow | null => window as unknown as BrowserWindow);
  const isQuitting = vi.fn(() => false);
  registerAppServerIntegrationHandlers({ getService, getMainWindow, isQuitting });
  const event = { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const read = (channel: string, input = event) => handlers.get(channel)!(input);
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
    },
  );
});
