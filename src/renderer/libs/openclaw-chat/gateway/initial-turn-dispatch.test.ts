import { describe, expect, it, vi } from 'vitest';

import { dispatchInitialTurn } from './initial-turn-dispatch';

describe('prepared initial turn dispatch', () => {
  it('uses only chat.send on the current rendering client and does not retry an uncertain failure', async () => {
    const request = vi.fn().mockRejectedValue(new Error('lost response'));
    const state = {
      connected: true,
      sessionKey: 'session-1',
      client: { generation: 1, gatewayUrl: 'ws://127.0.0.1:1', request },
    };
    const params = { sessionKey: 'session-1', message: 'hello', idempotencyKey: 'turn-1' };
    await expect(dispatchInitialTurn(state, params)).rejects.toMatchObject({
      message: 'lost response',
      requestSent: true,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('chat.send', params);
  });

  it('rejects disconnected or switched sessions before sending anything', async () => {
    const request = vi.fn();
    const client = { generation: 1, gatewayUrl: 'ws://127.0.0.1:1', request };
    await expect(
      dispatchInitialTurn({ connected: false, sessionKey: 'a', client }, { sessionKey: 'a' }),
    ).rejects.toMatchObject({ requestSent: false });
    await expect(
      dispatchInitialTurn({ connected: true, sessionKey: 'b', client }, { sessionKey: 'a' }),
    ).rejects.toMatchObject({ requestSent: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves a proven pre-send failure and a known native rejection', async () => {
    const failure = Object.assign(new Error('not connected'), { requestSent: false });
    const request = vi.fn().mockRejectedValueOnce(failure);
    const state = {
      connected: true,
      sessionKey: 'a',
      client: { generation: 1, gatewayUrl: 'ws://127.0.0.1:1', request },
    };
    await expect(dispatchInitialTurn(state, { sessionKey: 'a' })).rejects.toBe(failure);
    const rejection = Object.assign(new Error('denied'), { gatewayCode: 'NOT_AUTHORIZED' });
    request.mockRejectedValueOnce(rejection);
    await expect(dispatchInitialTurn(state, { sessionKey: 'a' })).rejects.toBe(rejection);
    expect(rejection).not.toHaveProperty('requestSent');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
