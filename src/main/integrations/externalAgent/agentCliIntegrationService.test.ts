import { expect, test, vi } from 'vitest';

import { AgentCliIntegrationService } from './agentCliIntegrationService';

test('status inspection never prepares the launcher or starts the desktop bridge', () => {
  const prepareLauncher = vi.fn(() => ({ path: process.execPath, command: process.execPath }));
  const service = new AgentCliIntegrationService({
    getBridgeState: () => ({ running: false, activeTaskCount: 0 }),
    getGatewayPhase: () => 'ready',
    prepareLauncher,
  });

  expect(service.getStatus()).toMatchObject({
    command: '',
    launcherReady: false,
    bridgeRunning: false,
    activeTaskCount: 0,
  });
  expect(prepareLauncher).not.toHaveBeenCalled();
});

test('desktop startup makes the command available without persistent enable settings', () => {
  let running = true;
  const service = new AgentCliIntegrationService({
    getBridgeState: () => ({ running, activeTaskCount: 2 }),
    getGatewayPhase: () => 'ready',
    prepareLauncher: () => ({ path: process.execPath, command: process.execPath }),
  });

  service.prepare();
  expect(service.getStatus()).toMatchObject({
    command: process.execPath,
    launcherReady: true,
    bridgeRunning: true,
    activeTaskCount: 2,
    gatewayPhase: 'ready',
  });
  running = false;
  expect(service.getStatus()).toMatchObject({ launcherReady: true, bridgeRunning: false });
});

test('failed launcher preparation does not advertise an earlier launcher as ready', () => {
  const prepareLauncher = vi.fn(() => ({ path: process.execPath, command: process.execPath }));
  const service = new AgentCliIntegrationService({
    getBridgeState: () => ({ running: true, activeTaskCount: 0 }),
    getGatewayPhase: () => 'running',
    prepareLauncher,
  });
  service.prepare();
  prepareLauncher.mockImplementation(() => {
    throw new Error('launcher unavailable');
  });

  expect(() => service.prepare()).toThrow('launcher unavailable');
  expect(service.getStatus()).toMatchObject({ command: '', launcherReady: false });
});
