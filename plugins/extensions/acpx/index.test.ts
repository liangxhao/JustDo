import { describe, expect, it, vi } from 'vitest';

const { dispatch, createService, getRuntime, redact } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getRuntime: vi.fn(),
  redact: vi.fn(),
  createService: vi.fn((_params: unknown) => ({
    id: 'fixture',
    start: async () => {},
    stop: async () => {},
  })),
}));
vi.mock('openclaw/plugin-sdk/acp-runtime-backend', () => ({
  tryDispatchAcpReplyHook: dispatch,
  getAcpRuntimeBackend: getRuntime,
}));
vi.mock('openclaw/plugin-sdk/security-runtime', () => ({ redactSensitiveText: redact }));
vi.mock('./register.runtime.js', () => ({ createAcpxRuntimeService: createService }));
vi.mock('./src/pi-session-catalog-plugin.js', () => ({ registerPiSessionCatalog: vi.fn() }));

import plugin from './index.js';

describe('managed ACP plugin registration', () => {
  it('lets native task policy own long replies and reads current allowed agents', () => {
    let allowedAgents = ['fixture'];
    const on = vi.fn();
    const api = {
      pluginConfig: { timeoutSeconds: 0.001, diagnosticAgents: ['fixture'] },
      runtime: {
        config: { current: () => ({ acp: { allowedAgents } }) },
        state: { openKeyedStore: vi.fn() },
      },
      registerService: vi.fn(),
      registerGatewayMethod: vi.fn(),
      on,
    };
    plugin.register(api as never);
    expect(on).toHaveBeenCalledExactlyOnceWith('reply_dispatch', dispatch, {
      eligibleDispatchKinds: ['acp'],
    });
    const getAllowedAgents = Reflect.get(createService.mock.calls.at(-1)![0], 'getAllowedAgents');
    expect(getAllowedAgents()).toEqual(['fixture']);
    allowedAgents = ['successor'];
    expect(getAllowedAgents()).toEqual(['successor']);
    expect(api.registerGatewayMethod).toHaveBeenCalledWith(
      'acpx.agent.doctor',
      expect.any(Function),
      { scope: 'operator.read' },
    );
  });

  it('redacts an adapter error before returning it to the caller', async () => {
    getRuntime.mockReturnValueOnce({
      runtime: { doctorAgent: vi.fn().mockRejectedValue(new Error('private adapter output')) },
    });
    redact.mockReturnValueOnce('redacted adapter output');
    const registerGatewayMethod = vi.fn();
    plugin.register({
      pluginConfig: { diagnosticAgents: ['fixture'] },
      registerService: vi.fn(),
      registerGatewayMethod,
      on: vi.fn(),
    } as never);

    const respond = vi.fn();
    await registerGatewayMethod.mock.calls[0][1]({ params: { agentId: 'fixture' }, respond });

    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: 'UNAVAILABLE',
      message: 'redacted adapter output',
    });
  });
});
