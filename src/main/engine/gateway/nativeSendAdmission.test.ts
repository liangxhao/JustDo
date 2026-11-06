import { describe, expect, it, vi } from 'vitest';

import type { CoworkNativeSendBinding } from '../types';
import { admitNativeSend, notifyNativeAccepted, prepareNativeSendBinding } from './nativeSendAdmission';
import type { GatewayClientLike } from './types';

const identity: CoworkNativeSendBinding = {
  sessionKey: 'agent:main:fixture-web-launch',
  nativeSessionId: 'physical-web-launch',
  lifecycleRevision: 'native-revision-7',
  clientGeneration: 3,
};

describe('native input admission boundary', () => {
  it('preserves the native opaque lifecycle revision and refuses numeric substitutes', async () => {
    const request = vi.fn().mockResolvedValueOnce({ session: { key: identity.sessionKey,
      sessionId: identity.nativeSessionId, lifecycleRevision: identity.lifecycleRevision } })
      .mockResolvedValueOnce({ session: { key: identity.sessionKey,
        sessionId: identity.nativeSessionId, lifecycleRevision: 7 } });
    const context = { ...identity, client: { request } as unknown as GatewayClientLike, isCurrent: () => true };
    await expect(prepareNativeSendBinding(context)).resolves.toEqual(identity);
    await expect(prepareNativeSendBinding(context)).rejects.toMatchObject({ requestSent: false });
  });
  it('rejects a connection replaced while the final identity read was in flight', async () => {
    let current = true;
    const request = vi.fn(async () => {
      current = false;
      return { session: { key: identity.sessionKey, sessionId: identity.nativeSessionId, lifecycleRevision: identity.lifecycleRevision } };
    });
    await expect(prepareNativeSendBinding({
      ...identity, client: { request } as unknown as GatewayClientLike, isCurrent: () => current,
    })).rejects.toMatchObject({ requestSent: false });
  });

  it('rejects a physical incarnation change before handing input to the transport', async () => {
    const request = vi.fn(async () => ({
      session: { key: identity.sessionKey, sessionId: 'replacement-session', lifecycleRevision: 'native-revision-8' },
    }));
    await expect(prepareNativeSendBinding({
      ...identity, client: { request } as unknown as GatewayClientLike, isCurrent: () => true,
    })).rejects.toMatchObject({ requestSent: false });
  });

  it('refuses an asynchronous final guard rather than reopening admission after an await', () => {
    expect(() => admitNativeSend(identity, async () => {}))
      .toThrow('Final native admission must be synchronous.');
  });

  it('never manufactures an ACK binding from the locally assigned input identity', () => {
    const onAccepted = vi.fn();
    expect(notifyNativeAccepted({ binding: identity, clientTurnId: 'local-input',
      receipt: { status: 'started' }, isCurrent: () => true, onAccepted })).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('passes the explicit native ID without conflating it with the client input ID', () => {
    const onAccepted = vi.fn();
    expect(notifyNativeAccepted({ binding: identity, clientTurnId: 'local-input',
      receipt: { runId: 'native-root', sessionId: identity.nativeSessionId },
      isCurrent: () => true, onAccepted })).toBe(true);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ ...identity,
      clientTurnId: 'local-input', nativeRunId: 'native-root' });
  });

  it('rejects ACKs naming another session or explicit lifecycle revision', () => {
    const onAccepted = vi.fn();
    for (const receipt of [
      { runId: 'native-root', sessionId: 'another-session' },
      { runId: 'native-root', lifecycleRevision: 'native-revision-8' },
      { runId: ' native-root' },
    ]) expect(notifyNativeAccepted({ binding: identity, clientTurnId: 'local-input', receipt,
      isCurrent: () => true, onAccepted })).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
  });
});
