import { afterEach, expect, test, vi } from 'vitest';

import { AppInitializationIpc, INITIALIZATION_WINDOW_ARGUMENT } from '../shared/app/initialization';

const electronMocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.expose },
  ipcRenderer: { invoke: electronMocks.invoke },
  webUtils: {},
}));

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.clearAllMocks();
  vi.resetModules();
});

test.each([
  { args: [], transient: false },
  { args: [INITIALIZATION_WINDOW_ARGUMENT], transient: true },
  { args: [`${INITIALIZATION_WINDOW_ARGUMENT}=true`], transient: false },
  { args: [`prefix${INITIALIZATION_WINDOW_ARGUMENT}`], transient: false },
])(
  'exposes exact initialization window context without requiring a ready Store: $args',
  async ({ args, transient }) => {
    process.argv = [originalArgv[0], 'preload-test', ...args];

    await import('./preload');

    expect(electronMocks.expose).toHaveBeenCalledOnce();
    const [name, bridge] = electronMocks.expose.mock.calls[0];
    expect(name).toBe('electron');
    expect(bridge.initialization.isTransientWindow).toBe(transient);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
    await bridge.initialization.getState();
    expect(electronMocks.invoke).toHaveBeenCalledWith(AppInitializationIpc.GetState);
  },
);
