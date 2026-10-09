import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import { startSubagentGatewayConnection } from './subagentGatewayConnection';

afterEach(() => vi.useRealTimers());

function setup(connect = vi.fn(async () => true)) {
  vi.useFakeTimers();
  const disconnect = vi.fn();
  const controller = { disconnect } as unknown as ChatController;
  let progress!: (engine: { phase: string }) => void;
  const unsubscribe = vi.fn();
  const onConnecting = vi.fn();
  const onFailure = vi.fn();
  const stop = startSubagentGatewayConnection({
    controller,
    connect,
    subscribeProgress: listener => {
      progress = listener;
      return unsubscribe;
    },
    onConnecting,
    onFailure,
  });
  return { connect, disconnect, progress, stop, unsubscribe, onConnecting, onFailure };
}

describe('subagent Gateway endpoint recovery', () => {
  it('retries unavailable endpoint discovery and stops retrying when transport starts', async () => {
    const state = setup(vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.onFailure).not.toHaveBeenCalled();
    state.stop();
  });

  it('rediscovers the endpoint after an engine restart without reconnecting on duplicate progress', async () => {
    const state = setup();
    await vi.advanceTimersByTimeAsync(0);
    state.progress({ phase: 'running' });
    expect(state.connect).toHaveBeenCalledTimes(1);
    state.progress({ phase: 'starting' });
    state.progress({ phase: 'running' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.disconnect).toHaveBeenCalledTimes(1);
    expect(state.onConnecting).toHaveBeenCalledTimes(2);
    state.progress({ phase: 'running' });
    expect(state.connect).toHaveBeenCalledTimes(2);
    state.stop();
  });

  it('serializes endpoint refresh behind an in-flight connection', async () => {
    let resolve!: (value: boolean) => void;
    const state = setup(
      vi
        .fn()
        .mockImplementationOnce(() => new Promise<boolean>(done => (resolve = done)))
        .mockResolvedValue(true),
    );
    state.progress({ phase: 'starting' });
    state.progress({ phase: 'running' });
    expect(state.connect).toHaveBeenCalledTimes(1);
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.disconnect).toHaveBeenCalledTimes(1);
    state.stop();
  });

  it('can recover on engine readiness after bounded discovery retries fail', async () => {
    const state = setup(vi.fn().mockResolvedValue(false));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(state.connect).toHaveBeenCalledTimes(4);
    expect(state.onFailure).toHaveBeenCalledTimes(1);
    state.connect.mockResolvedValue(true);
    state.progress({ phase: 'running' });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.connect).toHaveBeenCalledTimes(5);
    state.stop();
  });

  it('cancels scheduled discovery and subscriptions when the drawer closes', async () => {
    const state = setup(vi.fn().mockRejectedValue(new Error('Gateway unavailable')));
    await vi.advanceTimersByTimeAsync(0);
    state.stop();
    state.progress({ phase: 'running' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
    expect(state.onFailure).not.toHaveBeenCalled();
  });

  it('disconnects a late transport that finishes after the drawer closes', async () => {
    let resolve!: (value: boolean) => void;
    const state = setup(vi.fn(() => new Promise<boolean>(done => (resolve = done))));
    state.stop();
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.disconnect).toHaveBeenCalledTimes(2);
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
});
