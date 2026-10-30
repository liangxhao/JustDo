import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { expect, test, vi } from 'vitest';

import { SESSION_NAMESPACE_MAX_BYTES, SESSION_NAMESPACE_METHOD } from '../sdk/session-namespace';

const code = buildSync({
  entryPoints: [path.resolve(import.meta.dirname, '../session-namespaces.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['openclaw/plugin-sdk/*'],
}).outputFiles[0].text;

function fixture() {
  const entry: Record<string, unknown> = { sessionId: 'native', lifecycleRevision: 'r1' };
  const output = { exports: {} as { registerSessionNamespaces(api: unknown): void } };
  vm.runInNewContext(code, {
    module: output, exports: output.exports, TextEncoder,
    require: (name: string) => {
      if (name !== 'openclaw/plugin-sdk/session-store-runtime') throw new Error(name);
      return { getSessionEntry: vi.fn(() => entry) };
    },
  });
  let handler: (options: Record<string, unknown>) => void = () => { throw new Error('not registered'); };
  const lifecycle = new AbortController();
  const register = vi.fn((_name: string, callback: typeof handler) => { handler = callback; });
  output.exports.registerSessionNamespaces({ lifecycle: { signal: lifecycle.signal }, registerGatewayMethod: register });
  const params = { sessionKey: 'agent:main:source', nativeSessionId: 'native', lifecycleRevision: 'r1',
    pluginId: 'sample-owner', namespace: 'state' };
  const call = (extra: Record<string, unknown> = {}) => {
    const respond = vi.fn();
    handler({ params, respond, client: { connect: { client: { mode: 'backend' } } }, ...extra });
    return respond;
  };
  return { entry, lifecycle, register, params, call };
}

test('reads only the requested raw namespace and confirms missing namespaces explicitly', () => {
  const f = fixture();
  const value = { arbitrary: ['payload', false, null, 3], nested: { status: 'custom' } };
  f.entry.pluginExtensions = { 'sample-owner': { state: value, private: 'not returned' }, other: { secret: true } };
  const response = f.call();
  expect(response).toHaveBeenCalledWith(true, { ...f.params, present: true, value });
  const snapshot = response.mock.calls[0][1];
  expect(snapshot.value).not.toBe(value);
  expect(snapshot.value.nested).not.toBe(value.nested);
  f.entry.pluginExtensions = { 'sample-owner': { other: 1 } };
  expect(f.call()).toHaveBeenCalledWith(true, { ...f.params, present: false });
  delete f.entry.pluginExtensions;
  expect(f.call()).toHaveBeenCalledWith(true, { ...f.params, present: false });
  expect(f.register).toHaveBeenCalledWith(SESSION_NAMESPACE_METHOD, expect.any(Function),
    { scope: 'operator.admin', profileAccess: 'independent' });
});

test('malformed, unreadable, or oversized namespace data cannot become confirmed absence', () => {
  const f = fixture();
  const getter = vi.fn(() => 'secret');
  const unreadable = Object.defineProperty({}, 'state', { get: getter });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const extensions of [[], { 'sample-owner': null }, { 'sample-owner': { state: undefined } },
    { 'sample-owner': unreadable }, { 'sample-owner': { state: { invalid: undefined } } },
    { 'sample-owner': { state: cyclic } },
    { 'sample-owner': { state: 'x'.repeat(SESSION_NAMESPACE_MAX_BYTES) } }]) {
    f.entry.pluginExtensions = extensions;
    expect(f.call().mock.calls[0]).toEqual([false, undefined, {
      code: 'invalid_request', message: 'Native session namespace snapshot is unavailable.',
    }]);
  }
  expect(getter).not.toHaveBeenCalled();
});

test('rejects a different incarnation, stale caller, non-backend, and retired lifecycle', () => {
  const f = fixture();
  for (const drift of [{ nativeSessionId: 'replacement' }, { lifecycleRevision: 'r2' },
    { pluginId: '../owner' }, { extra: true }])
    expect(f.call({ params: { ...f.params, ...drift } }).mock.calls[0][0]).toBe(false);
  expect(f.call({ hasCurrentClientAuthority: () => false }).mock.calls[0][0]).toBe(false);
  expect(f.call({ client: { connect: { client: { mode: 'frontend' } } } }).mock.calls[0][0]).toBe(false);
  const request = new AbortController();
  request.abort();
  expect(f.call({ signal: request.signal }).mock.calls[0][0]).toBe(false);
  f.lifecycle.abort();
  expect(f.call().mock.calls[0][0]).toBe(false);
});
