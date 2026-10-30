import { expect, test, vi } from 'vitest';

import {
  cloneSessionNamespaceValue,
  readSessionNamespace,
  SESSION_NAMESPACE_MAX_BYTES,
  SESSION_NAMESPACE_METHOD,
} from '../session-namespace';

const input = { sessionKey: 'agent:main:source', nativeSessionId: 'native', lifecycleRevision: null,
  pluginId: 'sample-owner', namespace: 'custom.state' };

test('namespace client requires an exact incarnation and explicit absence or bounded JSON data', async () => {
  const request = vi.fn(async () => ({ ...input, present: true, value: { arbitrary: [1, null, false] } }));
  expect(await readSessionNamespace(request, input)).toEqual({ ...input, present: true,
    value: { arbitrary: [1, null, false] } });
  expect(request).toHaveBeenCalledExactlyOnceWith(SESSION_NAMESPACE_METHOD, input);
  expect(await readSessionNamespace(async () => ({ ...input, present: false }), input))
    .toEqual({ ...input, present: false });
  for (const drift of [{ nativeSessionId: 'replacement' }, { lifecycleRevision: 'r2' },
    { namespace: 'other' }, { present: false, value: undefined }, { present: true }, { extra: true }])
    await expect(readSessionNamespace(async () => ({ ...input, present: false, ...drift }), input))
      .rejects.toThrow('snapshot');
});

test('namespace snapshots do not silently erase non-JSON state or execute accessors', () => {
  const getter = vi.fn(() => 1);
  const unreadable = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const hiddenArrayValue = Object.defineProperty([], 'extra', { value: 'unreadable' });
  for (const value of [undefined, NaN, new Date(), new Map(), unreadable, cyclic, [undefined],
    hiddenArrayValue, { value: undefined }, 'x'.repeat(SESSION_NAMESPACE_MAX_BYTES)])
    expect(() => cloneSessionNamespaceValue(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
