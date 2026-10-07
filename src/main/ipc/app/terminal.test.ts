import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('node:fs/promises', () => ({ default: { stat: mocks.stat } }));

import { TerminalGateway, TerminalIpc } from '../../../shared/app/terminal';
import { registerTerminalHandlers, type TerminalHandlerDependencies } from './terminal';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  const events = new EventEmitter();
  const sender = { id: 7, send: vi.fn(), once: vi.fn(), isDestroyed: vi.fn(() => false) };
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === TerminalGateway.Open)
      return { sessionId: 'native-terminal-1', cwd: process.cwd() };
    if (method === TerminalGateway.Attach)
      return { sessionId: 'native-terminal-1', cwd: process.cwd(), buffer: 'ready', seq: 5 };
    return { ok: true };
  });
  let client = { request };
  let session: { cwd: string; agentId: string } | null = {
    cwd: process.cwd(),
    agentId: 'designer',
  };
  const runtime = {
    on: events.on.bind(events),
    getGatewayClient: () => client,
    connectGatewayIfNeeded: vi.fn(async () => undefined),
    prepareSession: vi.fn(async () => ({
      sessionKey: 'agent:designer:justdo:chat-1',
      gatewaySessionId: 'native-chat-1',
    })),
  };
  const deps = {
    getRuntime: () => runtime,
    ensureRunning: vi.fn(async () => undefined),
    getSession: vi.fn(() => session),
  } as unknown as TerminalHandlerDependencies;
  registerTerminalHandlers(deps);
  const call = (channel: string, value: unknown, owner = sender) =>
    mocks.handlers.get(channel)!({ sender: owner }, value);
  const open = (extra: object = {}) =>
    call(TerminalIpc.Create, {
      id: 'terminal:test',
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
      sessionId: 'chat-1',
      ...extra,
    });
  const emit = (event: string, payload: object) => events.emit('gatewayEvent', { event, payload });
  return {
    sender,
    request,
    runtime,
    deps,
    call,
    open,
    emit,
    events,
    setClient: (next: typeof client) => {
      client = next;
    },
    setSession: (next: typeof session) => {
      session = next;
    },
  };
}

describe('Gateway terminal IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
  });

  it('opens a terminal in the authoritative chat project and routes both human input and native output', async () => {
    const h = harness();
    expect(await h.open({ cwd: 'C:/untrusted-renderer-path' })).toEqual({
      success: true,
      cwd: process.cwd(),
    });
    expect(h.runtime.prepareSession).toHaveBeenCalledWith('chat-1');
    expect(h.request).toHaveBeenCalledWith(
      TerminalGateway.Open,
      expect.objectContaining({
        sessionKey: 'agent:designer:justdo:chat-1',
        agentId: 'designer',
        cwd: process.cwd(),
        cols: 100,
        rows: 30,
      }),
    );
    const launch = h.request.mock.calls.find(([method]) => method === TerminalGateway.Open)![1] as {
      shell: string;
      args: string[];
    };
    if (process.platform === 'win32') {
      expect(launch.shell).toMatch(/(?:powershell|pwsh)\.exe$/i);
      expect(launch.args.join(' ')).toContain('UTF8Encoding');
    }
    h.emit(TerminalGateway.Data, { sessionId: 'native-terminal-1', data: 'hello', seq: 5 });
    expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Data, {
      id: 'terminal:test',
      data: 'hello',
    });
    expect(await h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'pwd\r' })).toEqual({
      success: true,
    });
    expect(h.request).toHaveBeenCalledWith(TerminalGateway.Input, {
      sessionId: 'native-terminal-1',
      data: 'pwd\r',
    });
    expect(await h.call(TerminalIpc.Resize, { id: 'terminal:test', cols: 120, rows: 40 })).toEqual({
      success: true,
    });
    expect(h.request).toHaveBeenCalledWith(TerminalGateway.Resize, {
      sessionId: 'native-terminal-1',
      cols: 120,
      rows: 40,
    });
    expect(await h.call(TerminalIpc.Close, 'terminal:test')).toEqual({ success: true });
    expect(h.request).toHaveBeenCalledWith(TerminalGateway.Close, {
      sessionId: 'native-terminal-1',
      terminate: true,
    });
  });

  it('keeps homepage terminals connection-owned without creating a chat', async () => {
    const h = harness();
    await h.open({ sessionId: undefined });
    expect(h.runtime.prepareSession).not.toHaveBeenCalled();
    const params = h.request.mock.calls[0][1] as object;
    expect(params).not.toHaveProperty('sessionKey');
  });

  it('reserves admission and refuses a second window, missing sessions and malformed payloads', async () => {
    const h = harness();
    const gate = deferred<void>();
    h.runtime.connectGatewayIfNeeded.mockReturnValueOnce(gate.promise);
    const opening = h.open();
    await expect(h.open()).resolves.toMatchObject({ success: false });
    gate.resolve();
    await opening;
    await expect(
      h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'bad\r' }, { ...h.sender, id: 8 }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      h.call(TerminalIpc.Close, 'terminal:test', { ...h.sender, id: 8 }),
    ).resolves.toMatchObject({ success: false });
    h.setSession(null);
    await expect(h.open({ id: 'terminal:missing' })).resolves.toMatchObject({ success: false });
    await expect(h.open({ id: 'terminal:invalid', cols: NaN })).resolves.toMatchObject({
      success: false,
    });
    expect(h.request.mock.calls.filter(([method]) => method === TerminalGateway.Open)).toHaveLength(
      1,
    );
  });

  it('captures output before the open reply, including a native early exit', async () => {
    const h = harness();
    h.request.mockImplementationOnce(async () => {
      h.emit(TerminalGateway.Data, { sessionId: 'native-terminal-1', data: 'early', seq: 5 });
      return { sessionId: 'native-terminal-1', cwd: process.cwd() };
    });
    await h.open();
    expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Data, {
      id: 'terminal:test',
      data: 'early',
    });
    h.emit(TerminalGateway.Exit, { sessionId: 'native-terminal-1', exitCode: null });
    expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Exit, {
      id: 'terminal:test',
      exitCode: null,
    });
    await expect(
      h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'x' }),
    ).resolves.toMatchObject({ success: false });
  });

  it('uses a native snapshot when another pending terminal evicts its only admission output', async () => {
    const h = harness();
    h.request.mockImplementationOnce(async () => {
      h.emit(TerminalGateway.Data, { sessionId: 'native-terminal-1', data: 'done', seq: 4 });
      const data = 'x'.repeat(64 * 1024);
      h.emit(TerminalGateway.Data, {
        sessionId: 'another-pending-terminal',
        data,
        seq: data.length,
      });
      h.request.mockResolvedValueOnce({ sessionId: 'native-terminal-1', buffer: 'done', seq: 4 });
      return { sessionId: 'native-terminal-1', cwd: process.cwd() };
    });
    await expect(h.open()).resolves.toMatchObject({ success: true });
    expect(h.request).toHaveBeenCalledWith(TerminalGateway.Attach, {
      sessionId: 'native-terminal-1',
    });
    expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Data, {
      id: 'terminal:test',
      data: 'done',
      reset: true,
    });
  });

  it('does not leave a fake ready terminal when admission overflow drops its native exit', async () => {
    const h = harness();
    h.request.mockImplementationOnce(async () => {
      h.emit(TerminalGateway.Exit, { sessionId: 'native-terminal-1', exitCode: 0 });
      for (let i = 1; i <= 256; i++)
        h.emit(TerminalGateway.Data, { sessionId: 'another-pending-terminal', data: 'x', seq: i });
      h.request.mockRejectedValueOnce(new Error('unknown terminal session "native-terminal-1"'));
      return { sessionId: 'native-terminal-1', cwd: process.cwd() };
    });
    await expect(h.open()).resolves.toMatchObject({ success: false });
    await expect(
      h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'x' }),
    ).resolves.toMatchObject({ success: false });
  });

  it('reattaches the original PTY after reconnect and flushes output that races the replay', async () => {
    const h = harness();
    await h.open();
    h.events.emit('gatewayDisconnected');
    const replay = deferred<unknown>();
    const next = vi.fn().mockReturnValueOnce(replay.promise);
    h.setClient({ request: next });
    h.events.emit('gatewayReady');
    h.emit(TerminalGateway.Data, { sessionId: 'native-terminal-1', data: '!', seq: 6 });
    replay.resolve({ sessionId: 'native-terminal-1', buffer: 'ready', seq: 5 });
    await vi.waitFor(() =>
      expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Data, {
        id: 'terminal:test',
        data: '!',
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(TerminalGateway.Attach, { sessionId: 'native-terminal-1' });
    expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Data, {
      id: 'terminal:test',
      data: 'ready',
      reset: true,
    });
    expect(h.request.mock.calls.filter(([method]) => method === TerminalGateway.Open)).toHaveLength(
      1,
    );
  });

  it('recovers an offset gap without duplicating previously displayed output', async () => {
    const h = harness();
    await h.open();
    h.emit(TerminalGateway.Data, { sessionId: 'native-terminal-1', data: 'y', seq: 5 });
    await vi.waitFor(() =>
      expect(h.sender.send).toHaveBeenCalledWith(TerminalIpc.Data, {
        id: 'terminal:test',
        data: 'ready',
        reset: true,
      }),
    );
    h.sender.send.mockClear();
    h.emit(TerminalGateway.Data, { sessionId: 'native-terminal-1', data: 'ready', seq: 5 });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('never retries an input whose acceptance is unknown', async () => {
    const h = harness();
    await h.open();
    h.request.mockRejectedValueOnce(new Error('request timed out'));
    expect(
      await h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'dangerous-command\r' }),
    ).toMatchObject({ success: false });
    await h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'dangerous-command\r' });
    expect(
      h.request.mock.calls.filter(([method]) => method === TerminalGateway.Input),
    ).toHaveLength(1);
  });

  it('does not disable a recovered terminal when an old connection reports a late input failure', async () => {
    const h = harness();
    await h.open();
    const input = deferred<unknown>();
    h.request.mockReturnValueOnce(input.promise);
    const writing = h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'once\r' });
    h.events.emit('gatewayDisconnected');
    const next = vi.fn(async (method: string) =>
      method === TerminalGateway.Attach
        ? { sessionId: 'native-terminal-1', buffer: 'ready', seq: 5 }
        : { ok: true },
    );
    h.setClient({ request: next });
    h.events.emit('gatewayReady');
    await vi.waitFor(() =>
      expect(h.sender.send).toHaveBeenLastCalledWith(TerminalIpc.Status, {
        id: 'terminal:test',
        ready: true,
        failed: false,
      }),
    );
    h.sender.send.mockClear();
    input.reject(new Error('old connection timed out'));
    await expect(writing).resolves.toMatchObject({ success: false });
    expect(h.sender.send).not.toHaveBeenCalled();
    await expect(
      h.call(TerminalIpc.Write, { id: 'terminal:test', data: 'new\r' }),
    ).resolves.toEqual({ success: true });
    expect(next).toHaveBeenCalledWith(TerminalGateway.Input, {
      sessionId: 'native-terminal-1',
      data: 'new\r',
    });
    expect(
      h.request.mock.calls.filter(([method]) => method === TerminalGateway.Input),
    ).toHaveLength(1);
  });

  it('closes a PTY that finishes opening after its tab is removed', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    const opened = deferred<void>();
    h.request.mockImplementationOnce(async () => {
      opened.resolve();
      return gate.promise;
    });
    const pending = h.open();
    await opened.promise;
    await h.call(TerminalIpc.Close, 'terminal:test');
    gate.resolve({ sessionId: 'native-terminal-1', cwd: process.cwd() });
    expect(await pending).toMatchObject({ success: false });
    expect(h.request).toHaveBeenCalledWith(TerminalGateway.Close, {
      sessionId: 'native-terminal-1',
      terminate: true,
    });
  });

  it('retains a cancelled admission when termination times out and closes the same PTY after reconnect', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    const opened = deferred<void>();
    h.request.mockImplementationOnce(async () => {
      opened.resolve();
      return gate.promise;
    });
    const pending = h.open();
    await opened.promise;
    await h.call(TerminalIpc.Close, 'terminal:test');
    h.request.mockRejectedValueOnce(new Error('close timed out'));
    gate.resolve({ sessionId: 'native-terminal-1', cwd: process.cwd() });
    await expect(pending).resolves.toMatchObject({ success: false });
    const next = vi.fn(async (method: string) =>
      method === TerminalGateway.Attach
        ? { sessionId: 'native-terminal-1', buffer: '', seq: 0 }
        : { ok: true },
    );
    h.setClient({ request: next });
    h.events.emit('gatewayReady');
    await vi.waitFor(() =>
      expect(next).toHaveBeenCalledWith(TerminalGateway.Close, {
        sessionId: 'native-terminal-1',
        terminate: true,
      }),
    );
    expect(next).toHaveBeenCalledWith(TerminalGateway.Attach, { sessionId: 'native-terminal-1' });
    expect(next.mock.calls.filter(([method]) => method === TerminalGateway.Open)).toHaveLength(0);
  });

  it('ends the owned native PTY when the renderer window is destroyed', async () => {
    const h = harness();
    await h.open();
    h.sender.isDestroyed.mockReturnValue(true);
    h.sender.once.mock.calls[0][1]();
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith(TerminalGateway.Close, {
        sessionId: 'native-terminal-1',
        terminate: true,
      }),
    );
  });
});
