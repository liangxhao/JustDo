import type { NativeSessionDispatchRequest } from '@shared/cowork/nativeSessionDispatch';
import { describe, expect, it, vi } from 'vitest';

import { listenInitialSessionDispatch } from './nativeSessionDispatch';

const setup = (dispatch = vi.fn().mockResolvedValue({ runId: 'turn-1' })) => {
  let listener!: (request: NativeSessionDispatchRequest) => void;
  const api = {
    onNativeSessionDispatch: (callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    },
    respondNativeSessionDispatch: vi.fn().mockResolvedValue({ success: true }),
  };
  const stop = listenInitialSessionDispatch(api, 'turn-1', dispatch);
  const request = {
    requestId: 'request-1',
    clientTurnId: 'turn-1',
    sessionId: 'session-1',
    sessionKey: 'agent:main:justdo:session-1',
    params: { idempotencyKey: 'turn-1', sessionKey: 'agent:main:justdo:session-1' },
  };
  return { dispatch, api, stop, emit: (r = request) => listener(r), request };
};

describe('renderer initial turn dispatch', () => {
  it('consumes only the exact pending operation once', async () => {
    const s = setup();
    s.emit({ ...s.request, clientTurnId: 'other' });
    s.emit({ ...s.request, params: { ...s.request.params, sessionKey: 'other' } });
    expect(s.dispatch).not.toHaveBeenCalled();
    s.emit();
    s.emit();
    await vi.waitFor(() => expect(s.api.respondNativeSessionDispatch).toHaveBeenCalledTimes(1));
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    s.stop();
    s.emit();
    expect(s.dispatch).toHaveBeenCalledTimes(1);
  });
  it('reports unknown transport outcomes without retrying chat.send', async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('request timeout: chat.send'), { requestSent: true }),
      );
    const s = setup(dispatch);
    s.emit();
    await vi.waitFor(() =>
      expect(s.api.respondNativeSessionDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, requestSent: true }),
      ),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('reports explicit pre-send rejection as unsubmitted', async () => {
    const s = setup(vi.fn().mockRejectedValue(new Error('Selection changed')));
    s.emit();
    await vi.waitFor(() =>
      expect(s.api.respondNativeSessionDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ requestSent: false }),
      ),
    );
  });
});
