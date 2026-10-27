import { expect, test, vi } from 'vitest';

import { WebpageEmbedSettingsService } from './webpageEmbedSettingsService';

const snapshot = (config: unknown = {}) => ({
  valid: true, hash: 'viewed', configRevisionHash: 'resolved', appliedConfigHash: 'resolved', config,
});
function fixture(config: unknown = {}) {
  const request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => snapshot(config));
  const state = { connected: true, current: true };
  const connection = { client: { request: request as never }, isCurrent: () => state.current };
  const exclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const getConnection = vi.fn(() => state.connected ? connection : null);
  return { request, state, exclusive, getConnection,
    service: new WebpageEmbedSettingsService({ getConnection, exclusive }) };
}
const edit = { allowExternalEmbedUrls: true, revision: 'viewed' };

test('reads native false by default without exposing other config or credentials', async () => {
  const { service, request, exclusive } = fixture({ models: { private: 'secret' } });
  expect(await service.getSettings()).toEqual({ success: true, value: {
    allowExternalEmbedUrls: false, revision: 'viewed', applied: true,
  } });
  expect(request).toHaveBeenCalledExactlyOnceWith('config.get', {});
  expect(exclusive).toHaveBeenCalledTimes(1);
});

test.each([true, false])('reads an existing manual native setting %s', async allowed => {
  const { service } = fixture({ gateway: { controlUi: { allowExternalEmbedUrls: allowed } } });
  expect(await service.getSettings()).toMatchObject({ success: true, value: { allowExternalEmbedUrls: allowed } });
});

test.each([
  null, [], { gateway: null }, { gateway: [] }, { gateway: { controlUi: null } },
  { gateway: { controlUi: { allowExternalEmbedUrls: 'true' } } },
])('rejects invalid native configuration %j', async config => {
  const { service } = fixture(config);
  expect(await service.getSettings()).toEqual({ success: false, code: 'configuration' });
});

test.each([{ valid: false }, { hash: '' }])('rejects invalid native snapshots %j', async override => {
  const { service, request } = fixture();
  request.mockResolvedValueOnce({ ...snapshot(), ...override });
  expect(await service.getSettings()).toEqual({ success: false, code: 'configuration' });
});

test('patches only the native flag with the displayed CAS revision, then reads back', async () => {
  const { service, request, exclusive } = fixture({ gateway: { controlUi: { allowExternalEmbedUrls: true } } });
  expect(await service.saveSettings(edit)).toMatchObject({ success: true, value: { allowExternalEmbedUrls: true } });
  expect(request).toHaveBeenNthCalledWith(1, 'config.patch', {
    baseHash: 'viewed', raw: JSON.stringify({ gateway: { controlUi: { allowExternalEmbedUrls: true } } }),
  });
  expect(request).toHaveBeenNthCalledWith(2, 'config.get', {});
  expect(exclusive).toHaveBeenCalledTimes(1);
});

test.each([
  null, [], {}, { ...edit, allowExternalEmbedUrls: 'true' }, { ...edit, revision: '' },
  { ...edit, revision: 'x'.repeat(1025) }, { ...edit, gateway: {} },
])('rejects malformed edits before entering native mutation %j', async input => {
  const { service, request, exclusive } = fixture();
  expect(await service.saveSettings(input)).toEqual({ success: false, code: 'invalid' });
  expect(request).not.toHaveBeenCalled();
  expect(exclusive).not.toHaveBeenCalled();
});

test('returns unavailable without starting or obtaining another client while offline', async () => {
  const { service, request, state, getConnection } = fixture();
  state.connected = false;
  expect(await service.getSettings()).toEqual({ success: false, code: 'unavailable' });
  expect(await service.saveSettings(edit)).toEqual({ success: false, code: 'unavailable' });
  expect(request).not.toHaveBeenCalled();
  expect(getConnection).toHaveBeenCalledTimes(2);
});

test.each([
  ['baseHash mismatch; config changed', 'conflict'], ['missing scope operator.admin', 'forbidden'],
  ['Gateway disconnected', 'unavailable'], ['timed out with private diagnostics', 'unavailable'],
])('reports %s without exposing raw diagnostics or replaying an uncertain write', async (message, code) => {
  const { service, request } = fixture();
  request.mockRejectedValueOnce(new Error(message));
  expect(await service.saveSettings(edit)).toEqual({ success: false, code });
  expect(request).toHaveBeenCalledTimes(1);
});

test('rejects overlapping writes before the shared config queue can replay stale intent', async () => {
  const { service, request } = fixture({ gateway: { controlUi: { allowExternalEmbedUrls: true } } });
  let resolve!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(settle => { resolve = settle; }));
  const first = service.saveSettings(edit);
  expect(await service.saveSettings({ ...edit, allowExternalEmbedUrls: false }))
    .toEqual({ success: false, code: 'busy' });
  resolve({ ok: true });
  expect(await first).toMatchObject({ success: true });
});

test('does not read a replacement connection after an uncertain patch', async () => {
  const { service, request, state, getConnection } = fixture();
  request.mockImplementationOnce(async () => {
    state.current = false;
    return { ok: true };
  });
  expect(await service.saveSettings(edit)).toEqual({ success: false, code: 'unavailable' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(getConnection).toHaveBeenCalledTimes(1);
});

test('does not publish a stale read when connection identity changes', async () => {
  const { service, request, state } = fixture();
  request.mockImplementationOnce(async () => {
    state.current = false;
    return snapshot();
  });
  expect(await service.getSettings()).toEqual({ success: false, code: 'unavailable' });
});

test('reports conflict when the native readback differs from the requested flag', async () => {
  const { service, request } = fixture();
  expect(await service.saveSettings(edit)).toEqual({ success: false, code: 'conflict' });
  expect(request).toHaveBeenCalledTimes(2);
});

test('returns the actual unconfirmed runtime state after a successful disk write', async () => {
  const { service, request } = fixture();
  request.mockResolvedValueOnce({ ok: true });
  request.mockResolvedValueOnce({ ...snapshot({ gateway: { controlUi: { allowExternalEmbedUrls: true } } }),
    appliedConfigHash: 'old' });
  expect(await service.saveSettings(edit)).toMatchObject({ success: true, value: { applied: false } });
});
