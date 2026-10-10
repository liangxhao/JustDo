import { EventEmitter } from 'node:events';

import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NativeSessionDispatchRequest } from '../../../shared/cowork/nativeSessionDispatch';
import { isGatewayRequestOutcomeUnknown } from '../../../shared/openclaw/gatewayRequestOutcome';
import { captureInitialDispatchLease, NativeSessionDispatcher } from './nativeSessionDispatch';

const setup = () => {
  const frame = { url: 'http://127.0.0.1:43127/' };
  let request: NativeSessionDispatchRequest;
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn((_channel: string, value: NativeSessionDispatchRequest) => {
      request = value;
    }),
  });
  const event = {
    sender: owner as unknown as WebContents,
    senderFrame: frame,
  } as IpcMainInvokeEvent;
  const dispatcher = new NativeSessionDispatcher();
  const dispatch = (lease?: { isCurrent: () => boolean }) =>
    dispatcher.dispatch(
      event,
      {
        clientTurnId: 'turn-1',
        sessionId: 'session-1',
        sessionKey: 'agent:main:justdo:session-1',
        params: { idempotencyKey: 'turn-1', sessionKey: 'agent:main:justdo:session-1' },
      },
      lease,
    );
  const response = (payload: unknown = { runId: 'turn-1' }) => ({
    requestId: request!.requestId,
    clientTurnId: 'turn-1',
    success: true,
    payload,
  });
  return { frame, owner, event, dispatcher, dispatch, response };
};

afterEach(() => vi.useRealTimers());

describe('initial turn transport ownership', () => {
  it('accepts one ACK only from the originating window and exact main frame', async () => {
    const s = setup();
    const pending = s.dispatch();
    expect(
      s.dispatcher.respond({ ...s.event, sender: {} } as IpcMainInvokeEvent, s.response()).success,
    ).toBe(false);
    expect(
      s.dispatcher.respond({ ...s.event, senderFrame: {} } as IpcMainInvokeEvent, s.response())
        .success,
    ).toBe(false);
    expect(s.dispatcher.respond(s.event, s.response()).success).toBe(true);
    await expect(pending).resolves.toEqual({ runId: 'turn-1' });
    expect(s.dispatcher.respond(s.event, s.response()).success).toBe(false);
    expect(s.owner.listenerCount('destroyed')).toBe(0);
  });

  it('rejects mismatched operation ids and malformed ACKs without consuming the handoff', async () => {
    const s = setup();
    const pending = s.dispatch();
    expect(s.dispatcher.respond(s.event, { ...s.response(), clientTurnId: 'other' }).success).toBe(
      false,
    );
    expect(s.dispatcher.respond(s.event, s.response({ runId: 'other-turn' })).success).toBe(false);
    expect(s.dispatcher.respond(s.event, s.response()).success).toBe(true);
    await expect(pending).resolves.toEqual({ runId: 'turn-1' });
  });

  it('revokes preparation on a same-URL reload before any handoff is sent', async () => {
    const s = setup();
    const invalidated = vi.fn();
    const lease = captureInitialDispatchLease(s.event, invalidated);
    s.owner.emit('did-start-navigation', {}, s.frame.url, false, true);
    expect(invalidated).toHaveBeenCalledTimes(1);
    const failure = await s.dispatch(lease).catch(e => e);
    expect(failure.requestSent).toBe(false);
    expect(isGatewayRequestOutcomeUnknown(failure)).toBe(false);
    expect(s.owner.send).not.toHaveBeenCalled();
    lease.dispose();
    expect(s.owner.listenerCount('did-start-navigation')).toBe(0);
  });

  it('does not accept an ACK after the frame URL changes', async () => {
    vi.useFakeTimers();
    const s = setup();
    const pending = s.dispatch().catch(e => e);
    s.frame.url = 'http://127.0.0.1:43127/other';
    expect(s.dispatcher.respond(s.event, s.response()).success).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isGatewayRequestOutcomeUnknown(await pending)).toBe(true);
    expect(s.owner.send).toHaveBeenCalledTimes(1);
  });

  it.each(['destroyed', 'render-process-gone'])(
    'retains uncertain admission on %s with no fallback send',
    async eventName => {
      const s = setup();
      const pending = s.dispatch().catch(e => e);
      s.owner.emit(eventName);
      expect(isGatewayRequestOutcomeUnknown(await pending)).toBe(true);
      expect(s.owner.send).toHaveBeenCalledTimes(1);
      expect(s.owner.listenerCount('did-start-navigation')).toBe(0);
    },
  );

  it('distinguishes a failure before send from an unknown dispatched request', async () => {
    const s = setup();
    const pending = s.dispatch().catch(e => e);
    s.dispatcher.respond(s.event, {
      ...s.response(),
      success: false,
      requestSent: false,
      error: 'Not connected',
    });
    expect(isGatewayRequestOutcomeUnknown(await pending)).toBe(false);
    const second = s.dispatch().catch(e => e);
    s.dispatcher.respond(s.event, {
      ...s.response(),
      success: false,
      requestSent: true,
      error: 'Connection closed',
    });
    expect(isGatewayRequestOutcomeUnknown(await second)).toBe(true);
  });

  it('does not consume a response with no native run id or an excessive payload', async () => {
    const s = setup();
    const pending = s.dispatch();
    expect(s.dispatcher.respond(s.event, s.response({})).success).toBe(false);
    expect(
      s.dispatcher.respond(s.event, s.response({ runId: 'turn-1', junk: 'x'.repeat(128 * 1024) }))
        .success,
    ).toBe(false);
    s.dispatcher.respond(s.event, s.response());
    await pending;
  });

  it('accepts only the native control receipt when no execution run is created', async () => {
    const s = setup();
    const pending = s.dispatch();
    expect(s.dispatcher.respond(s.event, s.response({ ok: true })).success).toBe(false);
    expect(
      s.dispatcher.respond(s.event, s.response({ ok: true, aborted: false, runIds: [42] })).success,
    ).toBe(false);
    const receipt = { ok: true, aborted: false, runIds: [] };
    expect(s.dispatcher.respond(s.event, s.response(receipt)).success).toBe(true);
    await expect(pending).resolves.toEqual(receipt);
  });
});
