import { beforeEach, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), get: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler),
    on: (name: string, handler: Handler) => mocks.handlers.set(name, handler),
  },
}));
vi.mock('../../core/window/workspaceWindowManager', () => ({
  getWorkspaceWindowManager: mocks.get,
}));

import { WorkspaceWindowIpc } from '../../../shared/cowork/workspaceWindow';
import { registerWorkspaceWindowHandlers } from './workspaceWindow';

beforeEach(() => {
  mocks.handlers.clear();
  mocks.get.mockReset();
  registerWorkspaceWindowHandlers();
});
const event = (ownerId = 10, routingId = 20) => ({
  sender: { id: ownerId, mainFrame: { processId: 1, routingId: 20 } },
  senderFrame: { processId: 1, routingId },
});

it('uses stable frame identity for the registered owner', () => {
  const prepare = vi.fn(() => ({ generation: 'current' }));
  mocks.get.mockReturnValue({ prepare });
  expect(mocks.handlers.get(WorkspaceWindowIpc.Prepare)!(event())).toEqual({
    generation: 'current',
  });
  expect(mocks.get).toHaveBeenCalledWith(10);
});
it('denies subframes and unregistered contents without creating a workspace', () => {
  expect(mocks.handlers.get(WorkspaceWindowIpc.Prepare)!(event(10, 21))).toBeNull();
  expect(mocks.get).not.toHaveBeenCalled();
  mocks.get.mockReturnValue(undefined);
  expect(
    mocks.handlers.get(WorkspaceWindowIpc.SetDetached)!(event(999), 'generation', true),
  ).toEqual({ success: false });
});

it('admits surface ownership only from the registered current owner main frame', () => {
  const prepareSurface = vi.fn(() => ({ id: 'owned' }));
  const updateSurface = vi.fn();
  const closeSurface = vi.fn();
  mocks.get.mockReturnValue({ prepareSurface, updateSurface, closeSurface });
  const update = { id: 'owned', target: 'main' };
  expect(mocks.handlers.get(WorkspaceWindowIpc.PrepareSurface)!(event(10, 21))).toBeNull();
  mocks.handlers.get(WorkspaceWindowIpc.UpdateSurface)!(event(10, 21), update);
  mocks.handlers.get(WorkspaceWindowIpc.CloseSurface)!(event(10, 21), 'owned');
  expect(prepareSurface).not.toHaveBeenCalled();
  expect(updateSurface).not.toHaveBeenCalled();
  expect(closeSurface).not.toHaveBeenCalled();
  expect(mocks.handlers.get(WorkspaceWindowIpc.PrepareSurface)!(event())).toEqual({ id: 'owned' });
  mocks.handlers.get(WorkspaceWindowIpc.UpdateSurface)!(event(), update);
  mocks.handlers.get(WorkspaceWindowIpc.CloseSurface)!(event(), 'owned');
  expect(updateSurface).toHaveBeenCalledExactlyOnceWith(update);
  expect(closeSurface).toHaveBeenCalledExactlyOnceWith('owned');
  mocks.get.mockReturnValue(undefined);
  expect(mocks.handlers.get(WorkspaceWindowIpc.PrepareSurface)!(event(999))).toBeNull();
});
it('keeps generation and payload validation owned by the window manager', () => {
  const setDetached = vi.fn(() => ({ success: false })),
    updateLayout = vi.fn();
  mocks.get.mockReturnValue({ setDetached, updateLayout });
  expect(mocks.handlers.get(WorkspaceWindowIpc.SetDetached)!(event(), 'stale', true)).toEqual({
    success: false,
  });
  expect(setDetached).toHaveBeenCalledWith('stale', true);
  mocks.handlers.get(WorkspaceWindowIpc.Update)!(event(10, 21), { generation: 'current' });
  expect(updateLayout).not.toHaveBeenCalled();
});

it('admits native controls only from the registered owner main frame', () => {
  const control = vi.fn(), getWindowState = vi.fn(() => ({ isMaximized: true }));
  mocks.get.mockReturnValue({ control, getWindowState });
  mocks.handlers.get(WorkspaceWindowIpc.Control)!(event(10, 21), 'current', 'close');
  expect(control).not.toHaveBeenCalled();
  expect(mocks.handlers.get(WorkspaceWindowIpc.GetWindowState)!(event(10, 21), 'current')).toBeNull();
  expect(getWindowState).not.toHaveBeenCalled();
  mocks.handlers.get(WorkspaceWindowIpc.Control)!(event(), 'current', 'minimize');
  expect(control).toHaveBeenCalledWith('current', 'minimize', undefined);
  expect(mocks.handlers.get(WorkspaceWindowIpc.GetWindowState)!(event(), 'current')).toEqual({ isMaximized: true });
  mocks.get.mockReturnValue(undefined);
  expect(mocks.handlers.get(WorkspaceWindowIpc.GetWindowState)!(event(999), 'current')).toBeNull();
  mocks.handlers.get(WorkspaceWindowIpc.Control)!(event(999), 'current', 'close');
  expect(control).toHaveBeenCalledTimes(1);
});
