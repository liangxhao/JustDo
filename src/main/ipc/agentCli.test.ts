import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

import { AgentCliIntegrationIpc } from '../../shared/integrations/agentCliIntegration';
import type { AgentCliIntegrationService } from '../integrations/externalAgent/agentCliIntegrationService';
import { registerAgentCliIntegrationHandlers } from './agentCli';

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
  const status = {
    supported: true,
    command: 'C:\\工具 目录\\assistant-cli.exe',
    launcherReady: true,
    bridgeRunning: true,
    activeTaskCount: 0,
    gatewayPhase: 'stopped',
  };
  const service = { getStatus: vi.fn(() => status) };
  const getService = vi.fn(() => service as unknown as AgentCliIntegrationService);
  const getMainWindow = vi.fn((): BrowserWindow | null => window as unknown as BrowserWindow);
  registerAgentCliIntegrationHandlers({ getService, getMainWindow });
  const event = { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const read = (input = event) => handlers.get(AgentCliIntegrationIpc.GetStatus)!(input);
  return { contents, window, status, service, getService, getMainWindow, event, read };
}

test('exposes only the read-only status method to the main application frame', () => {
  const f = fixture();

  expect(f.read()).toBe(f.status);

  expect([...handlers.keys()]).toEqual([AgentCliIntegrationIpc.GetStatus]);
  expect(Object.keys(AgentCliIntegrationIpc)).toEqual(['GetStatus']);
  expect(f.getService).toHaveBeenCalledOnce();
  expect(f.service.getStatus).toHaveBeenCalledOnce();
});

test.each(['child frame', 'other renderer', 'destroyed sender', 'destroyed window', 'no window'])(
  'rejects status reads from %s before resolving the service',
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
    } else {
      f.getMainWindow.mockReturnValue(null);
    }

    expect(() => f.read(event)).toThrow('main application frame');
    expect(f.getService).not.toHaveBeenCalled();
    expect(f.service.getStatus).not.toHaveBeenCalled();
  },
);
