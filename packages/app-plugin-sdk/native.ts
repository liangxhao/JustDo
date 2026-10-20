import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  appNativeDispatchMethod,
  type AppNativeDispatchOptions,
  type AppNativeHandshake,
  appNativeHandshakeMethod,
  appNativeGatewayMethodAlias,
  APP_NATIVE_MAX_GATEWAY_METHODS,
  type AppNativeGatewayMethod,
  createAppNativeUnknownOutcome,
} from './native-contract';

interface NativeError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}
export interface AppNativeDispatchResponse {
  ok: boolean;
  payload?: unknown;
  error?: NativeError;
  meta?: Record<string, unknown>;
}
/** Inject the public openclaw/plugin-sdk/gateway-method-runtime dispatcher. */
export type AppNativeDispatcher = (
  method: string,
  params?: unknown,
  options?: AppNativeDispatchOptions,
) => Promise<AppNativeDispatchResponse>;

export interface AppNativeRequest {
  req?: { readonly method: string };
  params: Record<string, unknown>;
  client: { connect: { client: { mode: string } } } | null;
  context: {
    isConfigReloadSettled(): boolean;
    getGatewayMethodRegistry?: () => { descriptors(): readonly AppNativeMethodDescriptor[] };
  };
  signal?: AbortSignal;
  hasCurrentClientAuthority?: () => boolean;
  respond(
    ok: boolean,
    payload?: unknown,
    error?: NativeError,
    meta?: Record<string, unknown>,
  ): void;
}

interface AppNativeMethodDescriptor {
  readonly name: string;
  readonly owner: { readonly kind: string; readonly pluginId?: string };
  readonly scope: string;
  readonly profileAccess: string;
  readonly sessionAccess?: AppNativeGatewayOptions['sessionAccess'];
  readonly shareKey?: AppNativeGatewayOptions['shareKey'];
  readonly shareInvalidationEvents?: readonly string[];
  readonly shareMaxAgeMs?: number;
}
export interface AppNativeGatewayOptions {
  readonly scope?:
    | 'operator.admin'
    | 'operator.read'
    | 'operator.write'
    | 'operator.sessions.read'
    | 'operator.sessions.write'
    | 'operator.approvals'
    | 'operator.questions'
    | 'operator.pairing'
    | 'operator.talk'
    | 'operator.talk.secrets';
  readonly profileAccess?: 'independent' | 'required';
  readonly sessionAccess?: { mode: 'write'; allowOwnSessionScope?: boolean; requiredTool?: string };
  readonly shareKey?: (
    caller: { client: AppNativeRequest['client']; read?: { shareable?: boolean } },
    params: Record<string, unknown>,
  ) => string | null;
  readonly shareInvalidationEvents?: readonly string[];
  readonly shareMaxAgeMs?: number;
}

/** Structural subset of the public OpenClawPluginApi, without a private Native dependency. */
export interface AppNativePluginApi {
  id: string;
  source: string;
  readonly runtimeSource?: string;
  lifecycle: {
    readonly signal?: AbortSignal;
    onDispose?: (dispose: () => void | Promise<void>) => () => void;
  };
  registerGatewayMethod(
    method: string,
    handler: (request: AppNativeRequest) => void | Promise<void>,
    options?: AppNativeGatewayOptions,
  ): void;
}

const registrations = new WeakMap<
  AppNativePluginApi,
  {
    receipt: AppNativeHandshake;
    proxy: AppNativePluginApi;
  }
>();
const registrationOptions = { scope: 'operator.admin', profileAccess: 'independent' } as const;

/** Preserve Native getters and non-enumerable authority fields without mutating its API. */
function nativeFacade<T extends object>(source: T, overrides: Partial<T>): T {
  const value = (key: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(overrides, key)
      ? Reflect.get(overrides, key)
      : Reflect.get(source, key, source);
  return new Proxy({} as T, {
    get: (_target, key) => value(key),
    set: (_target, key, next) =>
      Object.prototype.hasOwnProperty.call(overrides, key)
        ? false
        : Reflect.set(source, key, next, source),
    has: (_target, key) => Reflect.has(overrides, key) || Reflect.has(source, key),
    ownKeys: () => [...new Set([...Reflect.ownKeys(source), ...Reflect.ownKeys(overrides)])],
    getOwnPropertyDescriptor: (_target, key) =>
      Reflect.has(overrides, key) || Reflect.has(source, key)
        ? {
            configurable: true,
            enumerable: Reflect.getOwnPropertyDescriptor(source, key)?.enumerable ?? true,
            writable: false,
            value: value(key),
          }
        : undefined,
  });
}

/** Register a process-local receipt and authenticated forwarding boundary using public APIs only. */
export function registerAppNative(
  api: AppNativePluginApi,
  dispatch: AppNativeDispatcher,
): AppNativeHandshake {
  const previous = registrations.get(api);
  if (previous) return previous.receipt;
  if (
    !api.lifecycle.signal ||
    api.lifecycle.signal.aborted ||
    typeof api.lifecycle.onDispose !== 'function'
  ) {
    throw new Error('App Native registration requires public plugin lifecycle support');
  }
  const handshakeMethod = appNativeHandshakeMethod(api.id);
  const dispatchMethod = appNativeDispatchMethod(api.id);
  const source = api.runtimeSource ?? api.source;
  if (!isAbsolute(source)) throw new Error('App Native entry must be an absolute file');
  const nativeEntry = realpathSync(source);
  const entryStat = statSync(nativeEntry);
  if (!entryStat.isFile() || entryStat.size > 8 * 1024 * 1024) {
    throw new Error('App Native entry must be a supported single-file module');
  }
  const methods: AppNativeGatewayMethod[] = [];
  let sealed = false;
  let catalogVerified = false;
  const receipt: AppNativeHandshake = Object.freeze({
    pluginId: api.id,
    registrationId: randomUUID(),
    processId: process.pid,
    nativeEntry,
    // This snapshot never follows later disk edits. Adoption of changed bytes requires
    // the Main host to stop Gateway, validate the package and start a fresh process.
    sourceSha256: createHash('sha256').update(readFileSync(nativeEntry)).digest('hex'),
    get gatewayMethods() {
      return Object.freeze(methods.map(entry => Object.freeze({ ...entry })));
    },
  });
  let disposed = false;
  api.lifecycle.onDispose(() => {
    disposed = true;
  });
  const assertCurrent = (request: AppNativeRequest): void => {
    // Native owns configuration admission and commit authorization. A successful
    // agents/config write can respond before global reload bookkeeping becomes idle;
    // that activity does not retire this registration or its authenticated caller.
    if (
      disposed ||
      api.lifecycle.signal?.aborted ||
      request.signal?.aborted ||
      request.client?.connect.client.mode !== 'backend' ||
      !request.hasCurrentClientAuthority?.()
    ) {
      throw new Error('App Native registration is unavailable');
    }
  };
  const unavailable = (request: AppNativeRequest): void => {
    request.respond(false, undefined, {
      code: 'UNAVAILABLE',
      message: 'App Native registration is unavailable.',
    });
  };
  const descriptors = (request: AppNativeRequest) => {
    const registry = request.context.getGatewayMethodRegistry?.();
    if (!registry) throw new Error('App Native requires the public Gateway method registry view');
    return registry.descriptors();
  };
  const verifyCatalog = (request: AppNativeRequest) => {
    const entries = descriptors(request);
    const owned = (entry: AppNativeMethodDescriptor | undefined) =>
      entry?.owner.kind === 'plugin' && entry.owner.pluginId === api.id;
    for (const { method, alias } of methods) {
      const original = entries.find(entry => entry.name === method);
      const direct = entries.find(entry => entry.name === alias);
      if (
        !owned(original) ||
        !owned(direct) ||
        original!.scope !== direct!.scope ||
        original!.profileAccess !== direct!.profileAccess ||
        JSON.stringify(original!.sessionAccess) !== JSON.stringify(direct!.sessionAccess) ||
        // Native creates a separate lifetime wrapper for each registered callback.
        Boolean(original!.shareKey) !== Boolean(direct!.shareKey) ||
        JSON.stringify(original!.shareInvalidationEvents) !==
          JSON.stringify(direct!.shareInvalidationEvents) ||
        original!.shareMaxAgeMs !== direct!.shareMaxAgeMs
      )
        throw new Error('App Native gateway registration conflicts with its Native descriptor');
    }
    if (
      entries.some(
        entry =>
          owned(entry) &&
          entry.name !== handshakeMethod &&
          entry.name !== dispatchMethod &&
          !methods.some(method => method.alias === entry.name || method.method === entry.name),
      )
    )
      throw new Error('App Native gateway registration bypassed its SDK facade');
  };
  const register = api.registerGatewayMethod;
  const registerNative: AppNativePluginApi['registerGatewayMethod'] = (method, handler, options) =>
    Reflect.apply(register, api, [method, handler, options]);
  const registerOwned: AppNativePluginApi['registerGatewayMethod'] = (method, handler, options) => {
    if (
      sealed ||
      methods.length >= APP_NATIVE_MAX_GATEWAY_METHODS ||
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u.test(method) ||
      /\.app\.(?:handshake|dispatch|rpc)(?:\.|$)/u.test(method) ||
      methods.some(entry => entry.method === method)
    )
      throw new Error('Invalid or sealed App Native gateway registration');
    const alias = appNativeGatewayMethodAlias(receipt, methods.length);
    // Public registerGatewayMethod documentation reserves these admin namespaces.
    // Normalize before aliasing, then verify exact final Native descriptors below.
    const scope = /^(?:config\.|exec\.approvals\.|wizard\.|update\.)/u.test(method)
      ? 'operator.admin'
      : (options?.scope ?? 'operator.admin');
    const originalOptions =
      options &&
      Object.freeze({
        ...options,
        ...(options.sessionAccess
          ? { sessionAccess: Object.freeze({ ...options.sessionAccess }) }
          : {}),
        ...(options.shareInvalidationEvents
          ? { shareInvalidationEvents: Object.freeze([...options.shareInvalidationEvents]) }
          : {}),
      });
    const aliasOptions = Object.freeze({ ...originalOptions, scope });
    registerNative(method, handler, originalOptions);
    registerNative(
      alias,
      async request => {
        let entered = false;
        let explicitError = false;
        try {
          assertCurrent(request);
          if (!catalogVerified || request.req?.method !== alias)
            throw new Error('App Native alias is unavailable before its registration handshake');
          verifyCatalog(request);
          entered = true;
          await handler(
            nativeFacade(request, {
              req: Object.freeze({ ...request.req, method }),
              respond: (...args) => {
                // Explicit Native errors retain their full authoritative envelope.
                if (args[0]) assertCurrent(request);
                request.respond(...args);
                explicitError ||= !args[0];
              },
            }),
          );
          if (!explicitError) assertCurrent(request);
        } catch {
          if (entered && !explicitError)
            request.respond(false, undefined, {
              code: 'UNAVAILABLE',
              message: 'App Native dispatch outcome is unknown.',
              details: createAppNativeUnknownOutcome(receipt, method),
              retryable: false,
            });
          else if (!entered) unavailable(request);
          // Explicit Native errors stay authoritative. An ACK alone cannot prove
          // the later execution outcome; clients awaiting a final frame see unknown.
        }
      },
      aliasOptions,
    );
    methods.push(Object.freeze({ method, alias }));
  };
  const proxy = nativeFacade(api, { registerGatewayMethod: registerOwned });
  const state = { receipt, proxy };
  registrations.set(api, state);
  registrations.set(proxy, state);
  registerNative(
    handshakeMethod,
    request => {
      try {
        assertCurrent(request);
        if (Object.keys(request.params).length) throw new Error('Invalid App Native handshake');
        verifyCatalog(request);
        sealed = true;
        catalogVerified = true;
        request.respond(true, receipt);
      } catch {
        unavailable(request);
      }
    },
    registrationOptions,
  );
  registerNative(
    dispatchMethod,
    async request => {
      let dispatchedMethod: string | undefined;
      try {
        assertCurrent(request);
        const input = request.params;
        if (
          Object.keys(input).some(
            key => !['registrationId', 'processId', 'method', 'params', 'options'].includes(key),
          ) ||
          input.registrationId !== receipt.registrationId ||
          input.processId !== receipt.processId ||
          typeof input.method !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u.test(input.method) ||
          /\.app\.(?:handshake|dispatch|rpc)(?:\.|$)/u.test(input.method)
        ) {
          throw new Error('Invalid App Native dispatch');
        }
        if (
          descriptors(request).some(
            entry =>
              entry.name === input.method &&
              entry.owner.kind === 'plugin' &&
              entry.owner.pluginId === api.id,
          )
        )
          throw new Error('Plugin-owned RPCs require their direct Native alias');
        const options = input.options as AppNativeDispatchOptions | undefined;
        if (
          options !== undefined &&
          (!options ||
            typeof options !== 'object' ||
            Array.isArray(options) ||
            Object.keys(options).some(key => !['expectFinal', 'timeoutMs'].includes(key)) ||
            (options.expectFinal !== undefined && typeof options.expectFinal !== 'boolean') ||
            (options.timeoutMs !== undefined &&
              (!Number.isSafeInteger(options.timeoutMs) ||
                options.timeoutMs < 1 ||
                options.timeoutMs > 2_147_483_647)))
        ) {
          throw new Error('Invalid App Native dispatch options');
        }
        // The injected public dispatcher retains the original Native request scope,
        // client grants, profile, cancellation and instance-owned commit guards.
        dispatchedMethod = input.method;
        const result = await dispatch(dispatchedMethod, input.params, options);
        assertCurrent(request);
        request.respond(result.ok, result.payload, result.error, result.meta);
      } catch {
        if (dispatchedMethod) {
          // A retired/aborted dispatch can already have committed. The correlated
          // marker preserves uncertainty through the outer RPC error envelope.
          request.respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: 'App Native dispatch outcome is unknown.',
            details: createAppNativeUnknownOutcome(receipt, dispatchedMethod),
            retryable: false,
          });
        } else unavailable(request);
      }
    },
    registrationOptions,
  );
  return receipt;
}

/** The App builder applies this to every independent Native entry. */
export function withAppNative<T extends object>(plugin: T, dispatch: AppNativeDispatcher): T {
  if (typeof plugin === 'function') {
    const register = plugin as (api: AppNativePluginApi) => unknown;
    return Object.assign((api: AppNativePluginApi) => {
      registerAppNative(api, dispatch);
      return register(registrations.get(api)!.proxy);
    }, plugin) as T;
  }
  const register = Reflect.get(plugin, 'register');
  if (typeof register !== 'function') {
    throw new Error('App Native entry must export a registration function or plugin definition');
  }
  return {
    ...plugin,
    register(api: AppNativePluginApi) {
      registerAppNative(api, dispatch);
      return register.call(plugin, registrations.get(api)!.proxy);
    },
  };
}
