import { describe, expect, it, vi } from 'vitest';

import { appNativeGatewayMethodAlias, createAppNativeUnknownOutcome } from '../../../../packages/app-plugin-sdk/native-contract';
import { isGatewayRequestOutcomeUnknown } from '../../../shared/openclaw/gatewayRequestOutcome';
import {
  bindPluginGatewayClient,
  type PluginRequestBinding,
  runWithoutPluginRequestBinding,
  runWithPluginRequestBinding,
} from './pluginRequestBinding';
import type { GatewayClientLike } from './types';

const firstBinding: PluginRequestBinding = {
  pluginId: 'plugin-a', registrationId: '11111111-1111-4111-8111-111111111111', processId: 123,
  gatewayMethods: [],
};

function harness() {
  const request = vi.fn<GatewayClientLike['request']>().mockResolvedValue({ ok: true });
  const client = bindPluginGatewayClient({ request, start: vi.fn(), stop: vi.fn() });
  return { client, request };
}

describe('public plugin Gateway dispatch binding', () => {
  it('preserves ordinary requests and canonical request options', async () => {
    const h = harness();
    const params = { key: 'session' };
    const options = { expectFinal: true, timeoutMs: 200, signal: new AbortController().signal };
    await h.client.request('chat.send', params, options);
    expect(h.request).toHaveBeenCalledExactlyOnceWith('chat.send', params, options);
  });

  it('routes business RPCs using admitted registration instead of caller data', async () => {
    const h = harness();
    const params = { registrationId: 'foreign', processId: 999, method: 'unrelated' };
    const assertCurrent = vi.fn();
    await runWithPluginRequestBinding(firstBinding, assertCurrent, () =>
      h.client.request('sessions.create', params));
    expect(h.request).toHaveBeenCalledExactlyOnceWith('plugin-a.app.dispatch', {
      registrationId: firstBinding.registrationId, processId: 123, method: 'sessions.create', params,
    }, undefined);
    expect(assertCurrent).toHaveBeenCalledOnce();
  });

  it('sends an owned Native method directly with its original params and request options', async () => {
    const h = harness();
    const alias = appNativeGatewayMethodAlias(firstBinding, 0);
    const binding = { ...firstBinding, gatewayMethods: [{ method: 'pluginA.start', alias }] };
    const params = { state: 'running', registrationId: 'caller-data', options: { arbitrary: true } };
    const options = { expectFinal: true, timeoutMs: 500, signal: new AbortController().signal };
    const payload = { state: 'running', runId: 'run' };
    h.request.mockResolvedValue(payload);
    await expect(runWithPluginRequestBinding(binding, () => {}, () =>
      h.client.request('pluginA.start', params, options))).resolves.toBe(payload);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(alias, params, options);
    expect(h.request.mock.calls[0][1]).toBe(params);
    expect(h.request.mock.calls[0][2]).toBe(options);
  });

  it('deeply captures aliases so an old continuation cannot borrow another registration', async () => {
    const h = harness();
    const alias = appNativeGatewayMethodAlias(firstBinding, 0);
    const admitted = { ...firstBinding, gatewayMethods: [{ method: 'pluginA.start', alias }] };
    let resume!: () => void;
    const pause = new Promise<void>(resolve => { resume = resolve; });
    const pending = runWithPluginRequestBinding(admitted, () => {}, async () => {
      await pause;
      return h.client.request('pluginA.start', {});
    });
    const fresh = { ...firstBinding, registrationId: '22222222-2222-4222-8222-222222222222' };
    const freshAlias = appNativeGatewayMethodAlias(fresh, 0);
    admitted.gatewayMethods[0].method = 'other';
    admitted.gatewayMethods[0].alias = freshAlias;
    admitted.gatewayMethods.push({ method: 'pluginA.start', alias: freshAlias });
    await runWithPluginRequestBinding({ ...fresh, gatewayMethods: [{ method: 'pluginA.start', alias: freshAlias }] },
      () => {}, () => h.client.request('pluginA.start', {}));
    resume();
    await pending;
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([freshAlias, alias]);
  });

  it('classifies a correlated post-admission alias error as unknown without retrying', async () => {
    const h = harness();
    const binding = { ...firstBinding, gatewayMethods: [{
      method: 'pluginA.start', alias: appNativeGatewayMethodAlias(firstBinding, 0),
    }] };
    const error = Object.assign(new Error('target rejection'), {
      code: 'UNAVAILABLE', details: createAppNativeUnknownOutcome(binding, 'pluginA.start'),
    });
    h.request.mockRejectedValue(error);
    const failure = await runWithPluginRequestBinding(binding, () => {}, () =>
      h.client.request('pluginA.start', {})).catch((value: unknown) => value);
    expect(failure).not.toBe(error);
    expect(failure).toMatchObject({ code: 'CLIENT_TIMEOUT', requestSent: true, retryable: false, method: 'pluginA.start' });
    expect(isGatewayRequestOutcomeUnknown(failure)).toBe(true);
    expect(h.request).toHaveBeenCalledOnce();
  });

  it('preserves a direct Native alias rejection without a correlated unknown marker', async () => {
    const h = harness();
    const binding = { ...firstBinding, gatewayMethods: [{
      method: 'pluginA.start', alias: appNativeGatewayMethodAlias(firstBinding, 0),
    }] };
    const error = Object.assign(new Error('target rejection'), { code: 'UNAVAILABLE' });
    h.request.mockRejectedValue(error);
    await expect(runWithPluginRequestBinding(binding, () => {}, () =>
      h.client.request('pluginA.start', {}))).rejects.toBe(error);
    expect(h.request).toHaveBeenCalledOnce();
  });

  it.each([
    { gatewayMethods: undefined },
    { gatewayMethods: [{ method: 'pluginA.start', alias: 'foreign.alias' }] },
    { gatewayMethods: [
      { method: 'pluginA.start', alias: appNativeGatewayMethodAlias(firstBinding, 0) },
      { method: 'pluginA.start', alias: appNativeGatewayMethodAlias(firstBinding, 1) },
    ] },
    { registrationId: 'retired' },
    { processId: 0 },
  ])('rejects malformed bindings before an operation can fall back to Core: %j', override => {
    const h = harness();
    const operation = vi.fn(() => h.client.request('sessions.list', {}));
    expect(() => runWithPluginRequestBinding({ ...firstBinding, ...override } as PluginRequestBinding,
      () => {}, operation)).toThrow('appPluginUnavailable');
    expect(operation).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('forwards final response and timeout policy without serializing cancellation objects', async () => {
    const h = harness();
    const options = { expectFinal: true, timeoutMs: 750, signal: new AbortController().signal };
    await runWithPluginRequestBinding(firstBinding, () => {}, () =>
      h.client.request('agent', { message: 'hello' }, options));
    expect(h.request).toHaveBeenCalledExactlyOnceWith('plugin-a.app.dispatch', {
      registrationId: firstBinding.registrationId, processId: 123, method: 'agent',
      params: { message: 'hello' }, options: { expectFinal: true, timeoutMs: 750 },
    }, options);
    expect(h.request.mock.calls[0][2]).toBe(options);
  });

  it('keeps absent params absent and preserves explicit false options', async () => {
    const h = harness();
    await runWithPluginRequestBinding(firstBinding, () => {}, () =>
      h.client.request('models.list', undefined, { expectFinal: false }));
    expect(h.request.mock.calls[0][1]).toEqual({
      registrationId: firstBinding.registrationId, processId: 123, method: 'models.list',
      options: { expectFinal: false },
    });
  });

  it('captures immutable registration across asynchronous continuations', async () => {
    const h = harness();
    let resume!: () => void;
    const pause = new Promise<void>(resolve => { resume = resolve; });
    const admitted = { ...firstBinding };
    const old = runWithPluginRequestBinding(admitted, () => {}, async () => {
      await pause;
      return h.client.request('sessions.list', {});
    });
    admitted.registrationId = 'mutated';
    admitted.processId = 999;
    const fresh = '22222222-2222-4222-8222-222222222222';
    await runWithPluginRequestBinding({ ...firstBinding, registrationId: fresh }, () => {}, () =>
      h.client.request('sessions.list', {}));
    resume();
    await old;
    expect(h.request.mock.calls.map(([, params]) => params)).toEqual([
      { registrationId: fresh, processId: 123, method: 'sessions.list', params: {} },
      { registrationId: firstBinding.registrationId, processId: 123, method: 'sessions.list', params: {} },
    ]);
  });

  it('rejects retired continuations before any native request', async () => {
    const h = harness();
    let current = true;
    let resume!: () => void;
    const pause = new Promise<void>(resolve => { resume = resolve; });
    const pending = runWithPluginRequestBinding(firstBinding, () => {
      if (!current) throw new Error('retired');
    }, async () => {
      await pause;
      return h.client.request('chat.send', { message: 'never sent' });
    });
    current = false;
    resume();
    await expect(pending).rejects.toThrow('retired');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('isolates cleanup and foreign requests without leaking or replacing the outer binding', async () => {
    const h = harness();
    await runWithPluginRequestBinding(firstBinding, () => {}, async () => {
      await runWithoutPluginRequestBinding(() => h.client.request('fixture.cleanup', {}));
      await runWithPluginRequestBinding({
        pluginId: 'plugin-b', registrationId: '22222222-2222-4222-8222-222222222222', processId: 456,
        gatewayMethods: [],
      }, () => {}, () => h.client.request('sessions.list', {}));
      await h.client.request('sessions.list', {});
    });
    await h.client.request('sessions.list', {});
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      'fixture.cleanup', 'plugin-b.app.dispatch', 'plugin-a.app.dispatch', 'sessions.list',
    ]);
  });

  it('rejects missing registration instead of inheriting an outer plugin or sending unbound', async () => {
    const h = harness();
    const requestWithoutRegistration = () => runWithPluginRequestBinding(undefined, () => {}, () =>
      h.client.request('chat.send', {}));
    expect(requestWithoutRegistration).toThrow('appPluginUnavailable');
    await runWithPluginRequestBinding(firstBinding, () => {}, async () => {
      expect(requestWithoutRegistration).toThrow('appPluginUnavailable');
      await h.client.request('sessions.list', {});
    });
    expect(h.request).toHaveBeenCalledExactlyOnceWith('plugin-a.app.dispatch', {
      registrationId: firstBinding.registrationId, processId: 123, method: 'sessions.list', params: {},
    }, undefined);
  });

  it('returns the native payload and error metadata without retrying unknown outcomes', async () => {
    const h = harness();
    const payload = { runId: 'run', runtime: { lifecycleGeneration: 'generation' } };
    const error = Object.assign(new Error('response lost'), {
      code: 'UNAVAILABLE', details: { outcome: 'unknown' }, retryable: false,
    });
    h.request.mockResolvedValueOnce(payload).mockRejectedValueOnce(error);
    await runWithPluginRequestBinding(firstBinding, () => {}, async () => {
      await expect(h.client.request('agent', {})).resolves.toBe(payload);
      await expect(h.client.request('chat.send', {})).rejects.toBe(error);
    });
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('binds a canonical client only once', async () => {
    const h = harness();
    expect(bindPluginGatewayClient(h.client)).toBe(h.client);
    await runWithPluginRequestBinding(firstBinding, () => {}, () =>
      h.client.request('sessions.list', {}));
    expect(h.request.mock.calls[0][1]).toEqual({
      registrationId: firstBinding.registrationId, processId: 123, method: 'sessions.list', params: {},
    });
    expect(h.request).toHaveBeenCalledOnce();
  });

  const validBinding: PluginRequestBinding = {
    ...firstBinding, registrationId: '11111111-1111-4111-8111-111111111111',
  };

  it.each(['code', 'gatewayCode'])(
    'recognizes only a correlated post-dispatch unknown receipt using %s',
    async codeProperty => {
      const h = harness();
      const original = Object.assign(new Error('App Native dispatch outcome is unknown.'), {
        [codeProperty]: 'UNAVAILABLE',
        details: createAppNativeUnknownOutcome(validBinding, 'chat.send'),
      });
      h.request.mockRejectedValue(original);

      const error = await runWithPluginRequestBinding(validBinding, () => {}, () =>
        h.client.request('chat.send', { idempotencyKey: 'same-send' }),
      ).catch((error: unknown) => error);

      expect(error).not.toBe(original);
      expect(error).toMatchObject({ code: 'CLIENT_TIMEOUT', requestSent: true, cause: original });
      expect(error).not.toHaveProperty('gatewayCode');
      expect(isGatewayRequestOutcomeUnknown(error)).toBe(true);
      expect(h.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { pluginId: 'plugin-b' },
    { registrationId: '22222222-2222-4222-8222-222222222222' },
    { processId: 456 },
    { method: 'agent' },
    { kind: 'other-unknown' },
    { extra: true },
  ])('preserves authoritative errors with a foreign or malformed receipt %j', async override => {
    const h = harness();
    const original = Object.assign(new Error('Native method rejected'), {
      code: 'UNAVAILABLE',
      details: { ...createAppNativeUnknownOutcome(validBinding, 'chat.send'), ...override },
    });
    h.request.mockRejectedValue(original);

    await expect(runWithPluginRequestBinding(validBinding, () => {}, () =>
      h.client.request('chat.send', {}),
    )).rejects.toBe(original);

    expect(isGatewayRequestOutcomeUnknown(original)).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary Native rejection and does not infer an unknown outcome from its text', async () => {
    const h = harness();
    const original = Object.assign(new Error('App Native dispatch outcome is unknown.'), {
      code: 'DENIED',
      details: createAppNativeUnknownOutcome(validBinding, 'chat.send'),
    });
    h.request.mockRejectedValue(original);
    await expect(runWithPluginRequestBinding(validBinding, () => {}, () =>
      h.client.request('chat.send', {}),
    )).rejects.toBe(original);
    expect(isGatewayRequestOutcomeUnknown(original)).toBe(false);
  });
});
