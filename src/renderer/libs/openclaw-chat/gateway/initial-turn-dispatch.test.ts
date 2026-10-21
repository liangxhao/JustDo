import { describe, expect, it, vi } from 'vitest';

import type { GatewayClient } from './client';
import { dispatchInitialTurn } from './initial-turn-dispatch';
import { McpAppSession } from './mcp-app-session';

describe('prepared initial turn dispatch', () => {
  it.each(['cancel', 'client', 'session', 'generation', 'incarnation'])(
    'does not send after %s during delayed canvas preparation',
    async change => {
      const request = vi.fn();
      const client = { generation: 1, gatewayUrl: 'ws://127.0.0.1:1', request };
      const state = {
        connected: true,
        sessionKey: 'agent:main:one',
        currentSessionId: 'physical',
        client,
      };
      const params = {
        sessionKey: state.sessionKey,
        sessionId: state.currentSessionId,
        idempotencyKey: 'turn',
      };
      let cancelled = false;
      const apps = new McpAppSession(() => ({
        client: client as unknown as GatewayClient,
        generation: 1,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: 'main',
        isCurrent: () => true,
      }));
      let resolve!: (value: {
        token: string;
        viewId: string;
        selected: boolean;
        priority: number;
      }) => void;
      const unregister = apps.registerCanvasPreparation(
        'mcp-app-editor',
        () =>
          new Promise(done => {
            resolve = done;
          }),
        () => true,
      );
      const beforeRequest = vi.fn();
      try {
        const pending = dispatchInitialTurn(state, params, beforeRequest, () => cancelled);
        const rejected = expect(pending).rejects.toMatchObject({ requestSent: false });
        if (change === 'cancel') cancelled = true;
        if (change === 'client') state.client = { ...client, request: vi.fn() };
        if (change === 'session') state.sessionKey = 'agent:main:other';
        if (change === 'generation') client.generation++;
        if (change === 'incarnation') state.currentSessionId = 'replacement';
        resolve({ token: 'private', viewId: 'mcp-app-editor', selected: true, priority: 2 });
        await rejected;
        expect(beforeRequest).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(state.client.request).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    },
  );

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
