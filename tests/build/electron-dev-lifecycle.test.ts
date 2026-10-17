import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import developmentParent from '../../src/shared/app/developmentParent.json';

const { stopElectron } = require('../../scripts/electron/electron-shutdown.cjs') as {
  stopElectron: (processChild: ReturnType<typeof child>, graceMs?: number) => Promise<void>;
};

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 1234, connected: true, exitCode: null as number | null,
    signalCode: null as string | null, send: vi.fn(), kill: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('owned development process shutdown', () => {
  it('does not force-terminate an application adopted by a newer terminal', async () => {
    const electron = child();
    const stopped = stopElectron(electron);
    electron.emit('message', developmentParent.released);
    await stopped;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(electron.kill).not.toHaveBeenCalled();
    expect(electron.listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requests Main cleanup and waits for exit instead of sending Windows kill signals', async () => {
    const electron = child();
    const stopped = stopElectron(electron);
    expect(electron.send).toHaveBeenCalledWith(developmentParent.shutdown, expect.any(Function));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(electron.kill).not.toHaveBeenCalled();
    electron.emit('close', 0);
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
    expect(electron.listenerCount('close')).toBe(0);
  });

  it('retains the cleanup grace period when the IPC pipe is already closing', async () => {
    const electron = child();
    electron.send.mockImplementation(() => { throw new Error('channel closed'); });
    const stopped = stopElectron(electron);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(electron.kill).not.toHaveBeenCalled();
    electron.emit('close', 0);
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an unresponsive child and cleans timers after synchronous forced exit', async () => {
    const electron = child();
    electron.kill.mockImplementation(() => electron.emit('close', null));
    const stopped = stopElectron(electron);
    await vi.advanceTimersByTimeAsync(50_000);
    await stopped;
    expect(electron.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds waiting if a forced process never reports close', async () => {
    const electron = child();
    const stopped = stopElectron(electron);
    await vi.advanceTimersByTimeAsync(55_000);
    await stopped;
    expect(electron.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function startRunner() {
  const vite = child(), electron = child();
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const waitOn = vi.fn(() => waiting);
  const launchElectron = vi.fn(() => electron);
  const host = Object.assign(new EventEmitter(), {
    env: {}, execPath: process.execPath, cwd: () => process.cwd(), exit: vi.fn(),
  });
  const modules: Record<string, unknown> = {
    child_process: { spawn: vi.fn(() => vite) }, path,
    '../../package.json': { devServer: { port: 43127 } },
    './find-free-port.cjs': { findFreePort: async () => 43127 },
    '../browser/prepare-browser-extension-dev-host.cjs': { prepareBrowserExtensionDevHost: () => null },
    '../multica/create-multica-dev-agent.cjs': { prepareMulticaDevAgent: () => undefined },
    './launch-electron.cjs': { launchElectron },
    './electron-shutdown.cjs': { stopElectron }, 'wait-on': waitOn,
  };
  const requireStub = Object.assign((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
    return modules[name];
  }, { resolve: () => path.resolve('node_modules/vite/package.json') });
  vm.runInNewContext(fs.readFileSync(path.resolve('scripts/electron/run-electron-dev.cjs'), 'utf8'), {
    require: requireStub, process: host, console: { log: vi.fn(), error: vi.fn() },
    __dirname: path.resolve('scripts/electron'),
  });
  return { vite, electron, ready, launchElectron, host, waitOn };
}

describe('development runner', () => {
  it('keeps serving Vite after a successful single-instance handoff', async () => {
    const h = startRunner();
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.electron.exitCode = 0;
    h.electron.emit('close', 0);
    expect(h.vite.kill).not.toHaveBeenCalled();
    expect(h.host.exit).not.toHaveBeenCalled();
    h.host.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.electron.send).not.toHaveBeenCalled();
    expect(h.vite.kill).toHaveBeenCalledOnce();
  });

  it('requests application cleanup when the Vite process fails', async () => {
    const h = startRunner();
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.vite.emit('close', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.electron.send).toHaveBeenCalledWith(developmentParent.shutdown, expect.any(Function));
    expect(h.electron.kill).not.toHaveBeenCalled();
    h.electron.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.host.exit).toHaveBeenCalledWith(1);
  });

  it('cancels startup without launching Electron after a late readiness result', async () => {
    const h = startRunner();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.waitOn).toHaveBeenCalledWith(expect.objectContaining({ timeout: 300_000, simultaneous: 1 }));
    h.host.emit('SIGINT');
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.launchElectron).not.toHaveBeenCalled();
    expect(h.vite.kill).toHaveBeenCalledOnce();
    expect(h.host.exit).toHaveBeenCalledWith(0);
  });

  it('waits for Electron cleanup before retiring Vite and exiting the supervisor', async () => {
    const h = startRunner();
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.launchElectron).toHaveBeenCalledOnce();
    h.host.emit('SIGINT');
    h.host.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.electron.send).toHaveBeenCalledOnce();
    expect(h.electron.kill).not.toHaveBeenCalled();
    expect(h.vite.kill).not.toHaveBeenCalled();
    expect(h.host.exit).not.toHaveBeenCalled();
    h.electron.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.vite.kill).toHaveBeenCalledOnce();
    expect(h.host.exit).toHaveBeenCalledWith(0);
  });
});
