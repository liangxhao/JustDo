import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn(), release: '10.0.26100' }));
vi.mock('node:os', () => ({ release: () => mocks.release }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { powerMonitor: new EventEmitter() };
});
vi.mock('./computerOverlayWindow', () => ({
  ComputerOverlayWindow: class {
    prepare = vi.fn();
    dispose = vi.fn();
    show = mocks.show;
    hide = mocks.hide;
  },
}));

import { powerMonitor } from 'electron';

import { bindComputerOverlay } from './bindComputerOverlay';

const event = {
  event: 'computer.activity',
  payload: {
    v: 2,
    execution: '00000000-0000-0000-0000-000000000001',
    id: '00000000-0000-0000-0000-000000000001',
    phase: 'start',
    cursor: true,
    click: false,
  },
};
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.release = '10.0.26100';
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }),
  );
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('clears on transport loss and removes all hooks and timers on shutdown', () => {
  const runtime = new EventEmitter();
  dispose = bindComputerOverlay(runtime);
  runtime.emit('gatewayEvent', event);
  expect(mocks.show).toHaveBeenCalledOnce();
  runtime.emit('gatewayDisconnected');
  expect(mocks.hide).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  dispose();
  expect(runtime.eventNames()).toEqual([]);
  expect((powerMonitor as unknown as EventEmitter).eventNames()).toEqual([]);
  runtime.emit('gatewayEvent', event);
  expect(mocks.show).toHaveBeenCalledOnce();
});

it('does not let heartbeats recreate the overlay while locked or suspended', () => {
  const runtime = new EventEmitter();
  const power = powerMonitor as unknown as EventEmitter;
  dispose = bindComputerOverlay(runtime);
  runtime.emit('gatewayEvent', event);
  power.emit('lock-screen');
  power.emit('suspend');
  runtime.emit('gatewayEvent', event);
  power.emit('resume');
  runtime.emit('gatewayEvent', event);
  expect(mocks.show).toHaveBeenCalledOnce();
  power.emit('unlock-screen');
  runtime.emit('gatewayEvent', event);
  expect(mocks.show).toHaveBeenCalledTimes(2);
});

it('leaves unsupported capture-exclusion systems without overlay listeners', () => {
  mocks.release = '10.0.18363';
  const runtime = new EventEmitter();
  dispose = bindComputerOverlay(runtime);
  expect(runtime.eventNames()).toEqual([]);
});
