import type { EventEmitter } from 'node:events';
import { release } from 'node:os';

import { powerMonitor } from 'electron';

import { COMPUTER_ACTIVITY_EVENT } from '../../../../shared/security/computerActivity';
import type { GatewayEventFrame } from '../../../engine/gateway/types';
import { ComputerOverlayController } from './computerOverlayController';
import { ComputerOverlayWindow } from './computerOverlayWindow';

export function bindComputerOverlay(runtime: EventEmitter): () => void {
  // Earlier Windows versions black out protected windows instead of excluding them.
  if (process.platform !== 'win32' || !(Number(release().split('.')[2]) >= 19041)) return () => {};
  const controller = new ComputerOverlayController(new ComputerOverlayWindow());
  let suspended = false;
  let locked = false;
  const onEvent = (event: GatewayEventFrame) => {
    if (!suspended && !locked && event.event === COMPUTER_ACTIVITY_EVENT)
      controller.receive(event.payload, event.seq);
  };
  const clear = () => controller.clear();
  const suspend = () => {
    suspended = true;
    clear();
  };
  const resume = () => {
    suspended = false;
  };
  const lock = () => {
    locked = true;
    clear();
  };
  const unlock = () => {
    locked = false;
  };
  runtime.on('gatewayEvent', onEvent);
  runtime.on('gatewayDisconnected', clear);
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  powerMonitor.on('lock-screen', lock);
  powerMonitor.on('unlock-screen', unlock);
  return () => {
    runtime.removeListener('gatewayEvent', onEvent);
    runtime.removeListener('gatewayDisconnected', clear);
    powerMonitor.removeListener('suspend', suspend);
    powerMonitor.removeListener('resume', resume);
    powerMonitor.removeListener('lock-screen', lock);
    powerMonitor.removeListener('unlock-screen', unlock);
    clear();
  };
}
