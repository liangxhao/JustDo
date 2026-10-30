import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  type AppNativeDispatcher,
  type AppNativeGatewayOptions,
  type AppNativePluginApi,
  type AppNativeRequest,
  registerAppNative,
  withAppNative,
} from '../../plugins/sdk/app-plugin-sdk/native';
import {
  appNativeDispatchMethod,
  appNativeHandshakeMethod,
  appNativeGatewayMethodAlias,
  createAppNativeUnknownOutcome,
  isAppNativeHandshake,
  parseAppNativeHandshakeReceipt,
} from '../../plugins/sdk/app-plugin-sdk/native-contract';
import {
  bindPluginGatewayClient,
  runWithoutPluginRequestBinding,
  runWithPluginRequestBinding,
} from '../../src/main/engine/gateway/pluginRequestBinding';
import type { GatewayClientLike } from '../../src/main/engine/gateway/types';
import { isGatewayRequestOutcomeUnknown } from '../../src/shared/openclaw/gatewayRequestOutcome';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^app-native-sdk-/u);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(dispatch: AppNativeDispatcher = vi.fn(async () => ({ ok: true }))) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-native-sdk-'));
  roots.push(root);
  const source = path.join(root, 'index.js');
  writeFileSync(source, 'export default { register() {} };');
  const lifecycle = new AbortController();
  const handlers = new Map<string, (request: AppNativeRequest) => void | Promise<void>>();
  const descriptors = new Map<
    string,
    {
      name: string;
      owner: { kind: string; pluginId: string };
      scope: string;
      profileAccess: string;
      sessionAccess?: unknown;
      shareKey?: AppNativeGatewayOptions['shareKey'];
      shareInvalidationEvents?: readonly string[];
      shareMaxAgeMs?: number;
    }
  >();
  let dispose: (() => void | Promise<void>) | undefined;
  const api: AppNativePluginApi = {
    id: 'sample-plugin',
    source,
    lifecycle: {
      signal: lifecycle.signal,
      onDispose: callback => {
        dispose = callback;
        return () => undefined;
      },
    },
    registerGatewayMethod: vi.fn((name, handler, options) => {
      expect(handlers.has(name)).toBe(false);
      handlers.set(name, handler);
      descriptors.set(name, {
        name,
        owner: { kind: 'plugin', pluginId: 'sample-plugin' },
        scope: /^(?:config\.|exec\.approvals\.|wizard\.|update\.)/u.test(name)
          ? 'operator.admin'
          : (options?.scope ?? 'operator.admin'),
        profileAccess: options?.profileAccess ?? 'required',
        sessionAccess: options?.sessionAccess,
        ...(options?.shareKey
          ? {
              shareKey: (caller, params) => options.shareKey!(caller, params),
              shareInvalidationEvents: options.shareInvalidationEvents ?? [],
              shareMaxAgeMs: options.shareMaxAgeMs ?? 1000,
            }
          : {}),
      });
    }),
  };
  const receipt = registerAppNative(api, dispatch);
  const request = (params: Record<string, unknown> = {}): AppNativeRequest => ({
    params,
    req: { method: appNativeHandshakeMethod('sample-plugin') },
    client: { connect: { client: { mode: 'backend' } } },
    context: {
      isConfigReloadSettled: () => true,
      getGatewayMethodRegistry: () => ({
        descriptors: () => [...descriptors.values()] as never,
      }),
    },
    hasCurrentClientAuthority: () => true,
    respond: vi.fn(),
  });
  return {
    api,
    source,
    receipt,
    handlers,
    descriptors,
    lifecycle,
    dispatch,
    request,
    dispose: () => dispose?.(),
    invoke: (kind: 'handshake' | 'dispatch', input: AppNativeRequest) =>
      handlers.get(`sample-plugin.app.${kind}`)!(input),
  };
}

describe('public Native registration bridge', () => {
  test('issues one source receipt per actual API registration without following later disk edits', () => {
    const f = fixture();
    expect(isAppNativeHandshake(f.receipt)).toBe(true);
    expect(parseAppNativeHandshakeReceipt(f.receipt)).toEqual(f.receipt);
    expect(f.receipt).toMatchObject({
      pluginId: 'sample-plugin',
      nativeEntry: realpathSync(f.source),
      processId: process.pid,
      sourceSha256: createHash('sha256').update('export default { register() {} };').digest('hex'),
    });
    const originalReceipt = f.receipt;
    writeFileSync(f.source, 'export default { register() { return 2; } };');
    expect(registerAppNative(f.api, f.dispatch)).toBe(originalReceipt);
    expect(f.api.registerGatewayMethod).toHaveBeenCalledTimes(2);
    const request = f.request();
    f.invoke('handshake', request);
    expect(request.respond).toHaveBeenCalledWith(true, originalReceipt);
    const next = fixture();
    expect(next.receipt.registrationId).not.toBe(originalReceipt.registrationId);
  });

  test('wraps independent plugins once and retains their registration context and exports', () => {
    const f = fixture();
    const register = vi.fn();
    const plugin = { id: f.api.id, register, arbitrary: { value: 1 } };
    const wrapped = withAppNative(plugin, f.dispatch);
    expect(wrapped.arbitrary).toBe(plugin.arbitrary);
    wrapped.register(f.api);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0].id).toBe(f.api.id);
    expect(register.mock.calls[0][0]).not.toBe(f.api);
    expect(f.api.registerGatewayMethod).toHaveBeenCalledTimes(2);
  });

  test('supports callable Native entries and rejects entries without a registration function', () => {
    const f = fixture();
    const register = Object.assign(vi.fn(), { label: 'function-entry' });
    const wrapped = withAppNative(register, f.dispatch);
    wrapped(f.api);
    expect(wrapped.label).toBe(register.label);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0].id).toBe(f.api.id);
    expect(f.api.registerGatewayMethod).toHaveBeenCalledTimes(2);
    expect(() => withAppNative({ id: 'invalid' }, f.dispatch)).toThrow(
      'registration function or plugin definition',
    );
  });

  test.each(['frontend', 'webchat', 'cli'])('rejects %s clients', async mode => {
    const f = fixture();
    const request = f.request();
    request.client!.connect.client.mode = mode;
    await f.invoke('handshake', request);
    expect(request.respond).toHaveBeenCalledWith(false, undefined, {
      code: 'UNAVAILABLE',
      message: expect.any(String),
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test.each(['authority', 'signal', 'dispose', 'lifecycle', 'params'])(
    'rejects unavailable handshake: %s',
    async invalid => {
      const f = fixture();
      const request = f.request();
      if (invalid === 'authority') request.hasCurrentClientAuthority = () => false;
      if (invalid === 'signal') request.signal = AbortSignal.abort();
      if (invalid === 'dispose') await f.dispose();
      if (invalid === 'lifecycle') f.lifecycle.abort();
      if (invalid === 'params') request.params = { pluginId: 'other' };
      await f.invoke('handshake', request);
      expect(request.respond).toHaveBeenCalledWith(false, undefined, {
        code: 'UNAVAILABLE',
        message: expect.any(String),
      });
    },
  );

  test('retains a live registration and resolves its host request across an applied configuration write', async () => {
    let reloadSettled = true;
    const created = {
      ok: true,
      agentId: 'created-agent',
      workspace: '/agent-workspace',
    };
    const dispatch = vi.fn(async (method: string) => {
      if (method === 'agents.list')
        return { ok: true, payload: { agents: [{ id: created.agentId }] } };
      // Native confirms this write before its unrelated reload bookkeeping becomes idle.
      reloadSettled = false;
      return { ok: true, payload: created, meta: { source: 'native' } };
    });
    const f = fixture(dispatch);
    const resolved = vi.fn();
    const pending = new Map([['host-request', resolved]]);
    withAppNative(
      {
        register(api: AppNativePluginApi) {
          api.registerGatewayMethod(
            'collaboration.resolve',
            ({ params, respond }) => {
              const settle = pending.get(String(params.requestId));
              pending.delete(String(params.requestId));
              settle?.(params.result);
              respond(true, { ok: true });
            },
            { scope: 'operator.write' },
          );
        },
      },
      dispatch,
    ).register(f.api);
    const transport = vi.fn<GatewayClientLike['request']>(async (method, params) => {
      const input = f.request((params ?? {}) as Record<string, unknown>);
      input.req = { method };
      input.context.isConfigReloadSettled = () => reloadSettled;
      await f.handlers.get(method)!(input);
      const [ok, payload, error] = vi.mocked(input.respond).mock.calls[0];
      if (!ok) throw Object.assign(new Error(error!.message), error);
      return payload as never;
    });
    const client = bindPluginGatewayClient({
      request: transport,
      start: vi.fn(),
      stop: vi.fn(),
    });
    const handshakeMethod = appNativeHandshakeMethod(f.api.id);
    const initial = await client.request(handshakeMethod, {});
    expect(initial).toBe(f.receipt);
    const { pluginId, registrationId, processId, gatewayMethods } = f.receipt;
    const params = { name: 'created-agent', workspace: '/agent-workspace' };
    await runWithPluginRequestBinding(
      { pluginId, registrationId, processId, gatewayMethods },
      () => {},
      async () => {
        expect(await client.request('agents.create', params)).toEqual(created);
        // Manager refreshes do not borrow the business invocation's nested dispatch.
        const current = await runWithoutPluginRequestBinding(() =>
          client.request(handshakeMethod, {}),
        );
        expect(current).toBe(initial);
        expect(reloadSettled).toBe(false);
        expect(await client.request('agents.list')).toEqual({ agents: [{ id: created.agentId }] });
        expect(
          await client.request('collaboration.resolve', {
            requestId: 'host-request',
            result: created,
          }),
        ).toEqual({ ok: true });
      },
    );
    expect(resolved).toHaveBeenCalledExactlyOnceWith(created);
    expect(pending.size).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, 'agents.create', params, undefined);
    expect(dispatch).toHaveBeenNthCalledWith(2, 'agents.list', undefined, undefined);
    expect(transport.mock.calls.map(([method]) => method)).toEqual([
      handshakeMethod,
      appNativeDispatchMethod(f.api.id),
      handshakeMethod,
      appNativeDispatchMethod(f.api.id),
      gatewayMethods[0].alias,
    ]);
  });

  test('forwards original params, final-response options and complete Native error metadata', async () => {
    const result = {
      ok: false,
      error: {
        code: 'DENIED',
        message: 'Profile denied',
        details: { profileId: 'one' },
        retryable: false,
        retryAfterMs: 5,
      },
      meta: { source: 'native' },
    };
    const dispatch = vi.fn(async () => result);
    const f = fixture(dispatch);
    const params = { sessionKey: 'session-one', requestId: 'original-send' };
    const options = { expectFinal: true, timeoutMs: 12_000 };
    const request = f.request({
      registrationId: f.receipt.registrationId,
      processId: f.receipt.processId,
      method: 'chat.send',
      params,
      options,
    });
    await f.invoke('dispatch', request);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('chat.send', params, options);
    expect(request.respond).toHaveBeenCalledWith(false, undefined, result.error, result.meta);
  });

  test.each([
    { registrationId: 'wrong' },
    { processId: process.pid + 1 },
    { method: 'other-plugin.app.dispatch' },
    { method: 'sample-plugin.app.handshake' },
    { method: 'other-plugin.app.rpc.registration.1.0' },
    { method: '' },
    { extra: true },
    { options: { expectFinal: 'true' } },
    { options: { timeoutMs: 0 } },
    { options: { timeoutMs: Number.POSITIVE_INFINITY } },
    { options: { scopes: ['operator.admin'] } },
    { options: null },
  ])('rejects forged, recursive or malformed dispatch %j', async override => {
    const f = fixture();
    const request = f.request({
      registrationId: f.receipt.registrationId,
      processId: f.receipt.processId,
      method: 'sessions.list',
      ...override,
    });
    await f.invoke('dispatch', request);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(request.respond).toHaveBeenCalledWith(false, undefined, {
      code: 'UNAVAILABLE',
      message: expect.any(String),
    });
  });

  test('does not publish success or retry when registration retires after admitted dispatch', async () => {
    let complete!: (value: { ok: boolean; payload: unknown }) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<{ ok: boolean; payload: unknown }>(resolve => {
          complete = resolve;
        }),
    );
    const f = fixture(dispatch);
    const request = f.request({
      registrationId: f.receipt.registrationId,
      processId: f.receipt.processId,
      method: 'chat.send',
      params: { requestId: 'one-and-only' },
    });
    const pending = f.invoke('dispatch', request);
    await f.dispose();
    complete({ ok: true, payload: { runId: 'possibly-committed' } });
    await pending;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(request.respond).toHaveBeenCalledWith(false, undefined, {
      code: 'UNAVAILABLE',
      message: 'App Native dispatch outcome is unknown.',
      details: createAppNativeUnknownOutcome(f.receipt, 'chat.send'),
      retryable: false,
    });
  });

  test.each(['retire', 'inner-timeout', 'cancel', 'authority'])(
    'keeps possibly committed work unknown through the actual Native and Main bridges: %s',
    async failure => {
      let effects = 0;
      let authority = true;
      const signal = new AbortController();
      const f = fixture(async () => {
        effects += 1;
        if (failure === 'retire') await f.dispose();
        if (failure === 'cancel') signal.abort();
        if (failure === 'authority') authority = false;
        if (failure === 'inner-timeout')
          throw Object.assign(new Error('synthetic nested dispatch timeout'), {
            code: 'CLIENT_TIMEOUT',
            requestSent: true,
          });
        return { ok: true, payload: { runId: 'possibly-committed' } };
      });
      const request = vi.fn<GatewayClientLike['request']>(async (_method, params) => {
        const input = f.request(params as Record<string, unknown>);
        input.signal = signal.signal;
        input.hasCurrentClientAuthority = () => authority;
        await f.invoke('dispatch', input);
        const [ok, payload, error] = vi.mocked(input.respond).mock.calls[0];
        if (!ok) throw Object.assign(new Error(error!.message), error);
        return payload as never;
      });
      const client = bindPluginGatewayClient({
        request,
        start: vi.fn(),
        stop: vi.fn(),
      });

      const { pluginId, registrationId, processId, gatewayMethods } = f.receipt;
      const error = await runWithPluginRequestBinding(
        { pluginId, registrationId, processId, gatewayMethods },
        () => {},
        () => client.request('chat.send', { idempotencyKey: 'one-original-send' }),
      ).catch((error: unknown) => error);

      expect(effects).toBe(1);
      expect(request).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({
        code: 'CLIENT_TIMEOUT',
        requestSent: true,
        retryable: false,
      });
      expect(error).not.toHaveProperty('gatewayCode');
      expect(isGatewayRequestOutcomeUnknown(error)).toBe(true);
    },
  );
});

describe('pure Native receipt contract', () => {
  test('validates exact shape and bounded fields', () => {
    const { receipt } = fixture();
    for (const value of [
      null,
      [],
      {},
      { ...receipt, additional: true },
      { ...receipt, pluginId: '../escape' },
      { ...receipt, registrationId: 'copy-of-a-plugin-name' },
      { ...receipt, processId: 0 },
      { ...receipt, processId: 1.1 },
      { ...receipt, nativeEntry: 'bad\0entry' },
      { ...receipt, sourceSha256: 'unverified' },
    ]) {
      expect(isAppNativeHandshake(value)).toBe(false);
      expect(() => parseAppNativeHandshakeReceipt(value)).toThrow();
    }
    expect(appNativeHandshakeMethod('sample-plugin')).toBe('sample-plugin.app.handshake');
    expect(appNativeDispatchMethod('sample-plugin')).toBe('sample-plugin.app.dispatch');
    expect(() => appNativeHandshakeMethod('../escape')).toThrow();
  });
});

describe('direct Native aliases', () => {
  function owned(
    method: string,
    handler: (request: AppNativeRequest) => void | Promise<void>,
    options?: Parameters<AppNativePluginApi['registerGatewayMethod']>[2],
  ) {
    const f = fixture();
    let facade!: AppNativePluginApi;
    withAppNative(
      {
        register(api: AppNativePluginApi) {
          facade = api;
          api.registerGatewayMethod(method, handler, options);
        },
      },
      f.dispatch,
    ).register(f.api);
    const alias = appNativeGatewayMethodAlias(f.receipt, 0);
    const handshake = () => f.invoke('handshake', f.request());
    const invoke = (input = f.request()) => {
      input.req = { method: alias };
      return f.handlers.get(alias)!(input);
    };
    return { ...f, facade, alias, handshake, invokeAlias: invoke };
  }

  test('retains raw frozen params, original method and non-enumerable Native authority fields', async () => {
    const params = Object.freeze({
      sessionKey: 'one',
      extra: { unmodified: true },
    });
    const guard = vi.fn();
    const handler = vi.fn((request: AppNativeRequest) => {
      expect(request.params).toBe(params);
      expect(request.req?.method).toBe('sample.read');
      expect(Reflect.get(request, 'sessionMutationCommitGuard')).toBe(guard);
      request.respond(true, { value: 'one' });
    });
    const f = owned('sample.read', handler, {
      scope: 'operator.read',
      profileAccess: 'independent',
    });
    f.handshake();
    const input = f.request(params);
    Object.defineProperty(input, 'sessionMutationCommitGuard', {
      value: guard,
      enumerable: false,
    });
    await f.invokeAlias(input);
    expect(handler).toHaveBeenCalledOnce();
    expect(input.respond).toHaveBeenCalledWith(true, { value: 'one' });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.descriptors.get(f.alias)?.scope).toBe('operator.read');
  });

  test('preserves public read-sharing metadata and refuses a changed alias policy', async () => {
    const shareKey = vi.fn(() => 'sample');
    const events = ['sample.changed'];
    const handler = vi.fn((request: AppNativeRequest) => request.respond(true, { value: 1 }));
    const f = owned('sample.read', handler, {
      scope: 'operator.read',
      shareKey,
      shareInvalidationEvents: events,
      shareMaxAgeMs: 500,
    });
    events.push('later.changed');
    f.handshake();
    expect(f.descriptors.get(f.alias)).toMatchObject({
      shareKey: expect.any(Function),
      shareInvalidationEvents: ['sample.changed'],
      shareMaxAgeMs: 500,
    });
    await f.invokeAlias();
    expect(handler).toHaveBeenCalledOnce();
    expect(f.descriptors.get(f.alias)!.shareKey).not.toBe(
      f.descriptors.get('sample.read')!.shareKey,
    );
    f.descriptors.get(f.alias)!.shareMaxAgeMs = 1000;
    const request = f.request();
    await f.invokeAlias(request);
    expect(handler).toHaveBeenCalledOnce();
    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: 'UNAVAILABLE' }),
    );
  });

  test('returns the complete handler promise after its early ACK', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let effects = 0;
    const f = owned('sample.accepted', async request => {
      request.respond(true, { status: 'accepted' });
      await gate;
      effects++;
    });
    f.handshake();
    const input = f.request();
    const pending = f.invokeAlias(input);
    expect(input.respond).toHaveBeenCalledWith(true, { status: 'accepted' });
    expect(effects).toBe(0);
    release();
    await pending;
    expect(effects).toBe(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  test.each(['config.custom', 'exec.approvals.custom', 'wizard.custom', 'update.custom'])(
    'preserves Native reserved-admin scope for %s',
    async method => {
      const f = owned(method, request => request.respond(true), {
        scope: 'operator.read',
      });
      const handshake = f.request();
      f.invoke('handshake', handshake);
      expect(handshake.respond).toHaveBeenCalledWith(true, f.receipt);
      expect(f.descriptors.get(f.alias)?.scope).toBe('operator.admin');
    },
  );

  test('preserves Native session/profile admission metadata and explicit Native error envelopes', async () => {
    const error = {
      code: 'INVALID_REQUEST',
      message: 'Target denied',
      details: { native: true },
      retryable: false,
    };
    const meta = { final: true };
    const f = owned('sample.session', request => request.respond(false, undefined, error, meta), {
      scope: 'operator.write',
      profileAccess: 'required',
      sessionAccess: {
        mode: 'write',
        allowOwnSessionScope: true,
        requiredTool: 'read',
      },
    });
    f.handshake();
    expect(f.descriptors.get(f.alias)).toMatchObject({
      scope: 'operator.write',
      profileAccess: 'required',
      sessionAccess: {
        mode: 'write',
        allowOwnSessionScope: true,
        requiredTool: 'read',
      },
    });
    const request = f.request();
    await f.invokeAlias(request);
    expect(request.respond).toHaveBeenCalledExactlyOnceWith(false, undefined, error, meta);
  });

  test.each(['foreign-owner', 'scope', 'profile', 'session'])(
    'rejects the entire conflicted catalog: %s',
    async invalid => {
      const callback = vi.fn();
      const f = owned('sample.effect', callback, { scope: 'operator.read' });
      const descriptor = f.descriptors.get(
        invalid === 'foreign-owner' ? 'sample.effect' : f.alias,
      )!;
      if (invalid === 'foreign-owner') descriptor.owner.pluginId = 'other-plugin';
      if (invalid === 'scope') descriptor.scope = 'operator.write';
      if (invalid === 'profile') descriptor.profileAccess = 'independent';
      if (invalid === 'session') descriptor.sessionAccess = { mode: 'write' };
      const handshake = f.request();
      f.invoke('handshake', handshake);
      expect(handshake.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: 'UNAVAILABLE' }),
      );
      await f.invokeAlias();
      expect(callback).not.toHaveBeenCalled();
    },
  );

  test('seals registrations, refuses Core fallback for own RPCs, and rejects stale aliases', async () => {
    const callback = vi.fn();
    const f = owned('sample.effect', callback);
    f.handshake();
    expect(() => f.facade.registerGatewayMethod('sample.late', callback)).toThrow('sealed');
    const request = f.request({
      registrationId: f.receipt.registrationId,
      processId: f.receipt.processId,
      method: 'sample.effect',
    });
    await f.invoke('dispatch', request);
    expect(f.dispatch).not.toHaveBeenCalled();
    f.lifecycle.abort();
    await f.invokeAlias();
    expect(callback).not.toHaveBeenCalled();
  });

  test('normal and reflective API access share the SDK facade even when the Native API is frozen', () => {
    const f = fixture();
    Object.freeze(f.api);
    withAppNative(
      {
        register(api: AppNativePluginApi) {
          expect(Object.getOwnPropertyDescriptor(api, 'registerGatewayMethod')?.value).toBe(
            api.registerGatewayMethod,
          );
          api.registerGatewayMethod('sample.reflective', () => undefined);
        },
      },
      f.dispatch,
    ).register(f.api);
    expect(f.receipt.gatewayMethods).toHaveLength(1);
  });

  test.each(['throw', 'retire'])('keeps alias post-commit %s unknown', async failure => {
    let effects = 0;
    const f = owned('sample.effect', async () => {
      effects++;
      if (failure === 'retire') await f.dispose();
      else throw new Error('Native target lost its transport');
    });
    f.handshake();
    const request = f.request();
    await f.invokeAlias(request);
    expect(effects).toBe(1);
    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: 'UNAVAILABLE',
        details: createAppNativeUnknownOutcome(f.receipt, 'sample.effect'),
        retryable: false,
      }),
    );
  });
});
