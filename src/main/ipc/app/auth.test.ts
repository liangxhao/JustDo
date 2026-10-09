import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { AuthIpc } from '../../../shared/app/auth';
import type { LoginService } from '../../core/app/auth/loginService';
import { registerAuthHandlers } from './auth';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent) => unknown) =>
      handlers.set(name, handler),
  },
}));
beforeEach(() => handlers.clear());

function setup() {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const service = { getState: vi.fn(), login: vi.fn(), logout: vi.fn(), retrySync: vi.fn() };
  registerAuthHandlers({
    getService: () => service as unknown as LoginService,
    getMainWindow: () => window as unknown as BrowserWindow,
  });
  const event = { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  return { event, service };
}

test('the main frame can invoke the fixed account operations', () => {
  const { event, service } = setup();
  handlers.get(AuthIpc.Login)!(event);
  handlers.get(AuthIpc.Logout)!(event);
  handlers.get(AuthIpc.RetrySync)!(event);
  expect(service.login).toHaveBeenCalledWith();
  expect(service.logout).toHaveBeenCalledWith();
  expect(service.retrySync).toHaveBeenCalledWith();
});

test('embedded pages, child frames and other windows cannot read or change account state', () => {
  const { event, service } = setup();
  for (const channel of [AuthIpc.GetState, AuthIpc.Login, AuthIpc.Logout, AuthIpc.RetrySync]) {
    expect(() =>
      handlers.get(channel)!({ ...event, senderFrame: {} } as IpcMainInvokeEvent),
    ).toThrow();
    expect(() => handlers.get(channel)!({ ...event, sender: {} } as IpcMainInvokeEvent)).toThrow();
  }
  expect(service.getState).not.toHaveBeenCalled();
  expect(service.login).not.toHaveBeenCalled();
});
